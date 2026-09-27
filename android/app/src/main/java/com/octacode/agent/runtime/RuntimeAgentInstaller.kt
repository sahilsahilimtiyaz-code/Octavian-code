package com.octacode.agent.runtime

import android.system.Os
import java.io.BufferedInputStream
import java.io.File
import java.io.FileInputStream
import java.nio.channels.Channels
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.StandardOpenOption
import java.util.UUID
import java.util.concurrent.locks.ReentrantLock
import java.util.zip.GZIPInputStream
import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream

/**
 * 按需 Agent CLI 的下载与安装（AndCode式首装流程在本仓库的落点）。
 *
 * 与整包 `RuntimeInstaller` 的区别：
 *  - 载荷是单个工具的 `tar.gz`，**不能自选落点**：只允许解进 `opt/agent-<name>/`，
 *    wrapper 由安装器按固定公式生成（见 [AgentCliArtifact]）；
 *  - 状态与整包运行时正交：`RuntimeStatus` 的阶段只在下载/解压期间借用
 *    `DOWNLOADING/EXTRACTING` 做进度展示，结束即回到 `READY`（调用方保证空闲）；
 *  - 整包升级会清空 `opt/agent-*`：是否在位由落盘文件 + `installed-agents.json`
 *    共同判定，缺失即报可下载，不做静默自动重装（流量要用户说了算）。
 */
class RuntimeAgentInstaller(
    private val store: RuntimeStore,
    private val status: RuntimeStatus,
    private val http: RuntimeHttp = RuntimeHttp(),
    private val externalCancellation: () -> Boolean = { false },
) {
    private val installLock = ReentrantLock()

    /** 一条 Agent 的展示状态：是否在位、是否可下载（清单声明了就有下载地址）。 */
    data class AgentCliState(
        val name: String,
        val version: String,
        val installed: Boolean,
        val downloadable: Boolean,
    )

    fun states(): List<AgentCliState> {
        val manifest = store.installedManifest() ?: return emptyList()
        if (manifest.agentClis.isEmpty()) return emptyList()
        val record = store.installedAgents()
        return manifest.agentClis.map { agent ->
            val recorded = record[agent.name]
            val present = isInstalled(agent)
            AgentCliState(
                name = agent.name,
                version = agent.version,
                installed = present && recorded?.sha256 == agent.sha256,
                downloadable = true,
            )
        }
    }

    /**
     * 下载并安装一个清单声明的 Agent。
     *
     * 前置条件（调用方 `MobileRuntimeController` 统一收口，这里再判一次是纵深）：
     * 已安装整包运行时、Harness 未运行、无终端会话。任一不满足抛受控错误，
     * **不写入任何东西**。
     */
    fun install(name: String, isIdle: () -> Boolean): List<AgentCliState> {
        if (!installLock.tryLock()) throw RuntimeFailure("INSTALL_IN_PROGRESS", "Agent 安装正在进行")
        try {
            checkCancelled()
            val manifest = store.installedManifest()
                ?: throw RuntimeFailure("RUNTIME_NOT_INSTALLED", "请先安装运行环境，再下载 Agent")
            val agent = manifest.agentClis.firstOrNull { it.name == name }
                ?: throw RuntimeFailure("AGENT_UNKNOWN", "清单中没有这个 Agent")
            if (!isIdle()) {
                throw RuntimeFailure("RUNTIME_BUSY", "请先停止 Harness 和 Ubuntu 终端")
            }
            val recorded = store.installedAgents()[name]
            if (recorded?.sha256 == agent.sha256 && isInstalled(agent)) return states()
            if (!RuntimeFiles.isDirectoryNoFollow(store.currentRoot)) {
                throw RuntimeFailure("RUNTIME_NOT_INSTALLED", "运行环境不可用，无法安装 Agent")
            }
            downloadAndInstall(agent)
            return states()
        } finally {
            if (installLock.isHeldByCurrentThread) installLock.unlock()
        }
    }

    private fun downloadAndInstall(agent: AgentCliArtifact) {
        val part = File(store.runtimeParent, "agent-${agent.name}-${agent.sha256.take(8)}.part")
        val staging = File(store.runtimeParent, "agent-staging-${UUID.randomUUID()}")
        try {
            status.update(
                RuntimePhase.DOWNLOADING,
                downloaded = 0,
                total = agent.compressedBytes,
            )
            http.downloadFile(agent.url, part, agent.compressedBytes, agent.sha256) { downloaded, total ->
                checkCancelled()
                status.update(RuntimePhase.DOWNLOADING, downloaded = downloaded, total = total)
            }
            checkCancelled()
            status.update(RuntimePhase.EXTRACTING, downloaded = 0, total = agent.extractedBytes)
            val binary = extractBinary(part, staging, agent) { extracted, total ->
                checkCancelled()
                status.update(RuntimePhase.EXTRACTING, downloaded = extracted, total = total)
            }
            checkCancelled()
            promote(agent, binary)
            cleanupIfPresent(part)
            cleanupIfPresent(staging)
            // 回到整包口径的闲置快照：不能把 Agent 的字节数留在全局进度里，
            // 否则界面会把运行时大小显示成 Agent 的体积。
            status.refreshIdle()
        } catch (error: Throwable) {
            cleanupIfPresent(staging)
            // 保留 .part 供下次断点续传（与整包相同的语义）；取消则按取消码上报。
            if (isCancelled()) {
                throw RuntimeFailure("INSTALL_CANCELLED", "Agent 安装已取消")
            }
            throw error as? RuntimeFailure
                ?: RuntimeFailure("AGENT_INSTALL_FAILED", "Agent 安装失败", error)
        }
    }

    /**
     * 从 tarball 里找出唯一的入口二进制。
     *
     * tar-slip 防御：绝对路径、反斜杠、控制字符、`..` 分段、符号链接、硬链接、
     * 设备节点一律拒绝；条目数与解压总量按清单声明封顶；入口必须恰好出现一次
     * （深度 ≤2，兼容「扁平」与「单层子目录」两种分发形态，不做更深的猜测）。
     */
    private fun extractBinary(
        archive: File,
        staging: File,
        agent: AgentCliArtifact,
        onProgress: (Long, Long) -> Unit,
    ): File {
        if (!MailboxTree.isRealDirectory(store.runtimeParent.toPath())) {
            throw RuntimeFailure("FILESYSTEM_ERROR", "运行时目录不可用")
        }
        MailboxTree.createDirectoriesNoFollow(store.runtimeParent.toPath(), staging.toPath())
        var entries = 0
        var extracted = 0L
        val found = mutableListOf<File>()
        try {
            FileInputStream(archive).use { raw ->
                BufferedInputStream(raw).use { buffered ->
                    GZIPInputStream(buffered).use { gzip ->
                        TarArchiveInputStream(gzip).use { tar ->
                            var entry: TarArchiveEntry? = tar.nextEntry as? TarArchiveEntry
                            while (entry != null) {
                                val current = entry
                                entries += 1
                                if (entries > RuntimeLimits.MAX_AGENT_ARCHIVE_ENTRIES) {
                                    throw RuntimeFailure("ARCHIVE_ENTRIES_EXCEEDED", "Agent 载荷条目超过限制")
                                }
                                val relative = sanitizedEntryPath(current.name)
                                if (current.isDirectory) {
                                    MailboxTree.createDirectoriesNoFollow(
                                        staging.toPath(),
                                        File(staging, relative).toPath(),
                                    )
                                } else if (current.isFile) {
                                    val size = current.size
                                    if (size < 0 || extracted > agent.extractedBytes - size) {
                                        throw RuntimeFailure("ARCHIVE_SIZE_MISMATCH", "Agent 载荷解压体积超过声明")
                                    }
                                    val target = File(staging, relative)
                                    MailboxTree.createDirectoriesNoFollow(
                                        staging.toPath(),
                                        (target.parentFile ?: staging).toPath(),
                                    )
                                    FileChannel.open(
                                        target.toPath(),
                                        StandardOpenOption.CREATE_NEW,
                                        StandardOpenOption.WRITE,
                                        LinkOption.NOFOLLOW_LINKS,
                                    ).use { channel ->
                                        Channels.newOutputStream(channel).use { output ->
                                            val buffer = ByteArray(64 * 1024)
                                            var remaining = size
                                            while (remaining > 0) {
                                                val read = tar.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt())
                                                if (read < 0) break
                                                output.write(buffer, 0, read)
                                                remaining -= read
                                            }
                                            if (remaining != 0L) {
                                                throw RuntimeFailure("ARCHIVE_SIZE_MISMATCH", "Agent 载荷条目提前结束")
                                            }
                                        }
                                        channel.force(true)
                                    }
                                    extracted += size
                                    onProgress(extracted, agent.extractedBytes)
                                    if (target.name == agent.binary && depthOf(relative) <= 2) {
                                        found += target
                                    }
                                } else {
                                    throw RuntimeFailure("ARCHIVE_ENTRY_UNSUPPORTED", "Agent 载荷含不支持的条目类型")
                                }
                                entry = tar.nextEntry as? TarArchiveEntry
                            }
                        }
                    }
                }
            }
        } catch (error: RuntimeFailure) {
            throw error
        } catch (error: Throwable) {
            throw RuntimeFailure("ARCHIVE_READ_FAILED", "Agent 载荷读取失败", error)
        }
        if (found.size != 1) {
            throw RuntimeFailure("AGENT_BINARY_NOT_FOUND", "Agent 载荷中没有唯一的入口文件")
        }
        return found.single()
    }

    private fun sanitizedEntryPath(raw: String): String {
        var value = raw
        while (value.startsWith("./")) value = value.drop(2)
        if (value.isEmpty() || value.startsWith("/") || value.startsWith("\\")) {
            throw RuntimeFailure("ARCHIVE_PATH_INVALID", "Agent 载荷路径无效")
        }
        if (value.contains('\\') || value.any { it.code < 0x20 || it.code == 0x7f }) {
            throw RuntimeFailure("ARCHIVE_PATH_INVALID", "Agent 载荷路径包含非法字符")
        }
        val segments = value.split('/')
        if (segments.any { it.isEmpty() || it == "." || it == ".." || it.length > 255 }) {
            throw RuntimeFailure("ARCHIVE_PATH_INVALID", "Agent 载荷路径分段无效")
        }
        return value
    }

    private fun depthOf(relative: String): Int = relative.split('/').size

    /**
     * 落盘：二进制 → 沙盒目录，wrapper → `usr/local/bin`，最后写安装记录。
     *
     * 顺序即 crash 安全顺序：记录是最后一步，任何一步中断都只留下「记录对不上文件」
     * 的状态，重装即可修复，不会出现「记录说装好了但文件缺失」。
     */
    private fun promote(agent: AgentCliArtifact, binary: File) {
        val current = store.currentRoot
        val sandbox = File(current, AgentCliArtifact.sandboxDir(agent.name))
        MailboxTree.createDirectoriesNoFollow(current.toPath(), sandbox.toPath())
        val stagedBinary = File(sandbox, ".${agent.binary}.${UUID.randomUUID()}.part")
        binary.inputStream().use { input ->
            FileChannel.open(
                stagedBinary.toPath(),
                StandardOpenOption.CREATE_NEW,
                StandardOpenOption.WRITE,
                LinkOption.NOFOLLOW_LINKS,
            ).use { channel ->
                Channels.newOutputStream(channel).use { output -> input.copyTo(output) }
                channel.force(true)
            }
        }
        Os.chmod(stagedBinary.absolutePath, 0x1ED)
        replaceFile(stagedBinary, File(sandbox, agent.binary))
        val wrapperBytes = AgentCliArtifact.wrapperBytes("agent-${agent.name}/${agent.binary}", agent.viaNode)
        val binDir = File(current, "usr/local/bin")
        MailboxTree.createDirectoriesNoFollow(current.toPath(), binDir.toPath())
        val stagedWrapper = File(binDir, ".${agent.name}.${UUID.randomUUID()}.part")
        FileChannel.open(
            stagedWrapper.toPath(),
            StandardOpenOption.CREATE_NEW,
            StandardOpenOption.WRITE,
            LinkOption.NOFOLLOW_LINKS,
        ).use { channel ->
            Channels.newOutputStream(channel).use { output -> output.write(wrapperBytes) }
            channel.force(true)
        }
        Os.chmod(stagedWrapper.absolutePath, 0x1ED)
        replaceFile(stagedWrapper, File(binDir, agent.name))
        store.writeInstalledAgents(store.installedAgents() + (agent.name to InstalledAgent(agent.name, agent.version, agent.sha256)))
    }

    private fun replaceFile(source: File, target: File) {
        try {
            if (RuntimeFiles.existsNoFollow(target) && !target.delete()) {
                throw RuntimeFailure("FILESYSTEM_ERROR", "无法替换旧的 Agent 文件")
            }
            Os.rename(source.absolutePath, target.absolutePath)
        } catch (error: RuntimeFailure) {
            cleanupIfPresent(source)
            throw error
        } catch (error: Throwable) {
            cleanupIfPresent(source)
            throw RuntimeFailure("FILESYSTEM_ERROR", "Agent 文件落盘失败", error)
        }
    }

    private fun isInstalled(agent: AgentCliArtifact): Boolean {
        val current = store.currentRoot
        if (!RuntimeFiles.isDirectoryNoFollow(current)) return false
        val wrapper = File(current, AgentCliArtifact.wrapperPath(agent.name))
        val binary = File(current, "${AgentCliArtifact.sandboxDir(agent.name)}/${agent.binary}")
        return RuntimeFiles.existsNoFollow(wrapper) && RuntimeFiles.existsNoFollow(binary) && binary.length() > 0
    }

    private fun cleanupIfPresent(file: File) {
        try {
            if (RuntimeFiles.existsNoFollow(file)) {
                if (RuntimeFiles.isDirectoryNoFollow(file)) {
                    Files.walk(file.toPath()).sorted(Comparator.reverseOrder()).forEach { Files.deleteIfExists(it) }
                } else {
                    Files.deleteIfExists(file.toPath())
                }
            }
        } catch (_: Throwable) {
        }
    }

    private fun checkCancelled() {
        if (isCancelled()) throw RuntimeFailure("INSTALL_CANCELLED", "Agent 安装已取消")
    }

    private fun isCancelled(): Boolean = externalCancellation()
}
