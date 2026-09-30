package com.octacode.agent.runtime

import android.content.Context
import android.os.Build
import com.octacode.agent.BuildConfig
import com.octacode.agent.runtime.diagnostics.DiagnosticEvent
import java.io.File

/**
 * 引擎启动解析器：给 OpenCode / Codex 这类自有聊天后端用的精简版启动档。
 *
 * 背景（真机事故复盘）：引擎最初是手拼 argv 直调 `prootArgv` 的——没有 resolv/hosts、
 * 没有用户目录绑定、seccomp 写死、没有探测与回退、没有预检。结果就是每一个新机型
 * 都以一种新姿势倒下（Bun SIGSEGV、getcwd ENOSYS……），而 Harness 侧早就有现成的
 * 解法（profile 探测 + 回退 + 预检）却够不着。本文件把引擎搬进同一套 machinery，
 * 但保持 Harness 路径零改动：只复用，不重构。
 *
 * 与 Harness 的区别（刻意的）：
 * - 凭据由调用方以 [RuntimeSecretDelivery] 直接传入，不经过 `prepareRuntimeSecrets`
 *  （那是 Harness 的模型凭据 + 临时令牌专线），也不挂 pid/auth-preload；
 * - 不读 Harness manifest：引擎只要求“运行时装好了”（installedManifest + 目录形态）；
 * - 探测命令是各引擎自己的 `--version`（真端到端：loader、绑定、seccomp 一次验完）。
 */
class EngineLaunchResolver(
    context: Context,
    private val store: RuntimeStore,
) {
    private val appContext = context.applicationContext
    private val lock = Any()
    private val profilePreferences =
        appContext.getSharedPreferences(ENGINE_PROFILE_PREFERENCES, Context.MODE_PRIVATE)
    private val storageDirs by lazy {
        RuntimeStorageDirs.from(appContext, store) { level, fields ->
            store.diagnostics.record(level, DiagnosticEvent.STORAGE_DIRS, fields)
        }
    }

    // internal：入参 RuntimeSecretDelivery 是 internal 类型，public 函数暴露它
    // 是编译错误（exposes its internal parameter type）；调用方（两个引擎服务）
    // 与本类同模块，internal 不影响任何使用。
    internal fun launchEngine(
        engineId: String,
        entrypoint: List<String>,
        probeEntrypoint: List<String>,
        cliRelativePath: String,
        secrets: RuntimeSecretDelivery,
        externalCancellation: () -> Boolean = { false },
    ): RuntimeLaunchSpec = synchronized(lock) {
        if (externalCancellation()) {
            throw RuntimeFailure("RUNTIME_START_INTERRUPTED", "Agent 服务启动已取消")
        }
        val manifest = store.installedManifest()
            ?: throw RuntimeFailure("RUNTIME_NOT_INSTALLED", "Ubuntu 运行时尚未安装")
        validateEngineGuest(store.currentRoot, cliRelativePath, engineId)
        store.prepareLaunchFiles()
        RuntimeDns.refresh(appContext, store.resolverFile)
        RuntimeDns.refreshHosts(store.hostsFile)
        val key = engineProfileKey(manifest, engineId)
        val serviceTag = "engine-$engineId"
        existingEngineProfile(engineId, key)?.let {
            return buildEngineLaunch(it, entrypoint, secrets, serviceTag)
        }
        val candidates = engineProfileCandidates(
            systemBinds = engineSystemBinds(),
            mailboxBinds = RuntimeMailbox(store).bindMounts(),
            storageBinds = storageDirs.bindMounts(),
        )
        val attempted = linkedSetOf<ProotLaunchProfile>()
        val failures = mutableListOf<ProcessProbeResult>()
        for (candidate in candidates) {
            if (!attempted.add(candidate)) continue
            val pending = ArrayDeque(listOf(candidate))
            while (pending.isNotEmpty()) {
                if (externalCancellation()) {
                    throw RuntimeFailure("RUNTIME_START_INTERRUPTED", "Agent 服务启动已取消")
                }
                val profile = pending.removeFirst()
                if (!attempted.add(profile)) continue
                val result = ProcessProbe.run(
                    buildEngineLaunch(profile, probeEntrypoint, RuntimeSecretDelivery.NONE, serviceTag),
                    store.currentRoot,
                    ENGINE_PROBE_TIMEOUT_SECONDS,
                    externalCancellation,
                )
                if (result.succeeded) {
                    rememberEngineProfile(engineId, key, profile)
                    return buildEngineLaunch(profile, entrypoint, secrets, serviceTag)
                }
                failures.add(0, result)
                engineFallbacks(profile, result).forEach { fallback ->
                    if (fallback !in attempted) pending.addLast(fallback)
                }
            }
        }
        val failure = failures.firstNotNullOfOrNull(RuntimeDiagnostics::prootFailure)
            ?: ClassifiedFailure("PROOT_GUEST_START_FAILED", "PRoot 无法启动 Ubuntu 用户空间")
        throw RuntimeFailure(failure.code, failure.message, failures.firstNotNullOfOrNull { it.startError })
    }

    private fun buildEngineLaunch(
        profile: ProotLaunchProfile,
        entrypoint: List<String>,
        secrets: RuntimeSecretDelivery,
        serviceTag: String,
    ) = RuntimeLaunchSpec(
        argv = RuntimeCommand.prootArgv(
            store = store,
            entrypoint = entrypoint,
            bindMounts = profile.bindMounts,
            secrets = secrets,
        ),
        environment = RuntimeCommand.hostEnvironment(appContext, store, serviceTag, profile.disableSeccomp),
        modelCredentialCount = secrets.modelCredentialCount,
    )

    private fun engineProfileKey(manifest: RuntimeManifest, engineId: String): String = listOf(
        "engine",
        engineId,
        BuildConfig.VERSION_CODE,
        Build.VERSION.SDK_INT,
        Build.FINGERPRINT,
        manifest.version,
        manifest.rootfs.sha256,
        RuntimeMailbox(store).mountableNow(),
        storageDirs.cacheToken(),
    ).joinToString(":")

    private fun existingEngineProfile(engineId: String, key: String): ProotLaunchProfile? {
        val storedKey = try {
            profilePreferences.getString(engineProfileKeyName(engineId), null)
        } catch (_: ClassCastException) {
            null
        }
        if (storedKey != key) return null
        val disableSeccomp = try {
            profilePreferences.getBoolean(engineProfileSeccompName(engineId), false)
        } catch (_: ClassCastException) {
            return null
        }
        // 挂载集合按当下重建（投递区/白名单可能变了），但 /proc 这一位必须按
        // 当初探中的值恢复——在部分机型上它是兼容性的决定项，不能每次都重置。
        val withProc = try {
            profilePreferences.getBoolean(engineProfileProcName(engineId), true)
        } catch (_: ClassCastException) {
            return null
        }
        // 挂载集合按**当下**的可选绑定可用性重建：偏好里只存上次探测成功的
        // seccomp 开关与 /proc 取舍，投递区与用户目录每次都重新判定，避免拿
        // 一份过期的绑定表启动——与 Harness 同一语义。
        val binds = buildList {
            addAll(engineSystemBinds())
            add(ProotBindMount("/dev"))
            if (withProc) add(ProotBindMount("/proc"))
            addAll(engineOptionalBinds())
        }
        return ProotLaunchProfile(disableSeccomp, binds)
            .also { /* 命中缓存：不再探测，直接沿用。 */ }
    }

    /** resolv/hosts：DNS 刷新后落盘，和 Harness 同一套文件。缺了它们模型流量先瞎。 */
    private fun engineSystemBinds(): List<ProotBindMount> = listOf(
        ProotBindMount(store.resolverFile.absolutePath, "/etc/resolv.conf"),
        ProotBindMount(store.hostsFile.absolutePath, "/etc/hosts"),
    )

    private fun rememberEngineProfile(engineId: String, key: String, profile: ProotLaunchProfile) {
        profilePreferences.edit()
            .putString(engineProfileKeyName(engineId), key)
            .putBoolean(engineProfileSeccompName(engineId), profile.disableSeccomp)
            .putBoolean(engineProfileProcName(engineId), profile.bindMounts.any { it.target == "/proc" })
            .apply()
    }

    private fun engineOptionalBinds(): List<ProotBindMount> =
        RuntimeMailbox(store).bindMounts() + storageDirs.bindMounts()

    private companion object {
        const val ENGINE_PROFILE_PREFERENCES = "engine_launch_profile"
        const val ENGINE_PROBE_TIMEOUT_SECONDS = 12L
        fun engineProfileKeyName(engineId: String) = "engine_profile_key_$engineId"
        fun engineProfileSeccompName(engineId: String) = "engine_profile_no_seccomp_$engineId"
        fun engineProfileProcName(engineId: String) = "engine_profile_proc_$engineId"
    }
}

/**
 * 引擎候选档（按探测顺序）：seccomp 关/开 × /proc 挂/不挂。
 *
 * seccomp 关在前（Bun 的 JIT 与新 glibc syscall 在部分机型的 filter 下直接 SIGSEGV）；
 * /proc 挂在前（标准形态，Harness 亦如此）；真机用探针投票，顺序只是起点。
 */
internal fun engineProfileCandidates(
    systemBinds: List<ProotBindMount>,
    mailboxBinds: List<ProotBindMount>,
    storageBinds: List<ProotBindMount>,
): List<ProotLaunchProfile> {
    fun binds(withProc: Boolean): List<ProotBindMount> = buildList {
        addAll(systemBinds)
        add(ProotBindMount("/dev"))
        if (withProc) add(ProotBindMount("/proc"))
        addAll(mailboxBinds)
        addAll(storageBinds)
    }
    // 注意：resolv/hosts 由调用方（launchEngine）在探测前落盘并追加——
    // 这里只排 seccomp × /proc 两个真变量，可选绑定由 prootProfileFallbacks 按失败摘除。
    return listOf(
        ProotLaunchProfile(disableSeccomp = true, binds(withProc = true)),
        ProotLaunchProfile(disableSeccomp = true, binds(withProc = false)),
        ProotLaunchProfile(disableSeccomp = false, binds(withProc = true)),
        ProotLaunchProfile(disableSeccomp = false, binds(withProc = false)),
    )
}

/**
 * 引擎回退：在 Harness 通用回退之外，再加“摘掉 /proc”一档。
 *
 * 背景：宿主 /proc 盖掉访客后，部分机型 getcwd() 直接 ENOSYS（sh 在入口脚本处就死）。
 * 这一档只在带 /proc 的档失败后出现一次，去重由调用方的 attempted 集合保证。
 */
internal fun engineFallbacks(
    profile: ProotLaunchProfile,
    result: ProcessProbeResult,
): List<ProotLaunchProfile> {
    val fallbacks = prootProfileFallbacks(profile, result, commandCanFail = true).toMutableList()
    if (profile.bindMounts.any { it.target == "/proc" }) {
        fallbacks += profile.copy(bindMounts = profile.bindMounts.filterNot { it.target == "/proc" })
    }
    return fallbacks.distinct()
}

/**
 * 引擎预检（纯文件判定，可单测）：-w 落点、CLI 本体存在可读。
 *
 * 不检查 x 位：部分 ROM/文件系统上 x 位不可信（见 runnerAvailable 注释），
 * 真正的“能不能跑”由探针说了算，这里只拦“连文件都没有”的形态。
 */
internal fun validateEngineGuest(root: File, cliRelativePath: String, engineLabel: String) {
    if (!root.isDirectory) {
        throw RuntimeFailure("RUNTIME_NOT_INSTALLED", "Ubuntu 运行时尚未安装")
    }
    if (!File(root, "root").isDirectory) {
        throw RuntimeFailure("RUNTIME_CORRUPTED", "运行时系统目录缺失，请重置后重装")
    }
    val cli = File(root, cliRelativePath)
    if (!cli.isFile || cli.length() == 0L || !cli.canRead()) {
        throw RuntimeFailure("AGENT_ENGINE_MISSING", "运行时未内置 $engineLabel，请先安装运行时")
    }
}
