package com.octacode.agent.runtime

import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import java.io.File

/**
 * 引擎残留回收：opencode / codex 这类自有聊天后端的小号清道夫。
 *
 * 背景：Harness 有一整套残留回收（pidfile + 环境标记 + 端口监听扫描），
 * 而引擎这边之前是零——应用被杀后访客进程经常活着，回来就撞上“端口被占”
 *（opencode）或彻底隐身（codex 没有端口可查）。这里补上最小可用的一套：
 * pidfile 认领 + 端口监听扫描 + 整树 SIGKILL，全部只认“我们的 runner”
 *（cmdline 比对），绝不碰别的 UID 或别的程序。
 *
 * 刻意不复用 RuntimeSupervisor 的私有实现：那些和 Harness 的
 * 环境标记、pidfile 强绑定，硬借只会把两个服务的生死搅在一起。
 */
internal object EngineResidual {
    /** 本进程的子进程 pid：优先官方 API，古董设备回退解析 toString。 */
    fun ownPid(process: Process): Int? {
        try {
            val pid = process.pid().toInt()
            if (pid > 1) return pid
        } catch (_: Throwable) {
        }
        return try {
            Regex("pid=(\\d+)").find(process.toString())
                ?.groupValues?.get(1)?.toIntOrNull()?.takeIf { it > 1 }
        } catch (_: Throwable) {
            null
        }
    }

    fun readPidFile(file: File): Int? = try {
        HarnessResidual.parsePid(file.readText())
    } catch (_: Exception) {
        null
    }

    fun writePidFile(file: File, pid: Int) {
        try {
            file.parentFile?.mkdirs()
            file.writeText(pid.toString())
        } catch (_: Exception) {
            // pidfile 写不下只影响下次回收，不阻断本次启动。
        }
    }

    fun deletePidFile(file: File) {
        try {
            file.delete()
        } catch (_: Exception) {
        }
    }

    fun isPidAlive(pid: Int): Boolean = try {
        Os.kill(pid, 0)
        true
    } catch (error: ErrnoException) {
        error.errno != OsConstants.ESRCH
    }

    fun isOurProot(pid: Int, runnerPath: String): Boolean {
        val cmdline = try {
            File("/proc/$pid/cmdline").readText()
        } catch (_: Exception) {
            return false
        }
        return HarnessResidual.isProotProcess(cmdline, runnerPath)
    }

    /** 自底向上 SIGKILL 整棵树：PRoot 的 tracee 经常比 tracer 活得长。 */
    fun killTree(pid: Int) {
        childPids(pid).forEach(::killTree)
        try {
            Os.kill(pid, OsConstants.SIGKILL)
        } catch (error: ErrnoException) {
            if (error.errno != OsConstants.ESRCH) {
                // 回收失败不阻断启动：端口检查仍会给出明确错误。
            }
        } catch (_: Exception) {
        }
    }

    private fun childPids(pid: Int): List<Int> {
        return try {
            File("/proc/$pid/task").listFiles().orEmpty().flatMap { task ->
                try {
                    File(task, "children").readText().trim()
                        .split(Regex("\\s+"))
                        .mapNotNull { it.toIntOrNull()?.takeIf { child -> child > 1 } }
                } catch (_: Exception) {
                    emptyList()
                }
            }.distinct()
        } catch (_: Exception) {
            emptyList()
        }
    }

    /**
     * 收割 pidfile 指向的残留：如果 pid 还活着且确实是我们的 runner，
     * 整树杀掉并删掉 pidfile。返回是否动手了（供诊断计数）。
     */
    fun reapPidFile(pidFile: File, runnerPath: String): Boolean {
        val pid = readPidFile(pidFile) ?: run {
            deletePidFile(pidFile)
            return false
        }
        if (!isPidAlive(pid)) {
            deletePidFile(pidFile)
            return false
        }
        if (!isOurProot(pid, runnerPath)) {
            // pid 被系统回收复用了：动它就是误杀，只删文件。
            deletePidFile(pidFile)
            return false
        }
        killTree(pid)
        deletePidFile(pidFile)
        return true
    }

    /**
     * 扫描监听指定 loopback 端口的本 UID 进程（/proc/net/tcp[6] → inode → fd）。
     * 给“端口被占但不知道是谁”的场景一个不靠猜的答案：返回持有者 pid 列表。
     */
    fun findPortListeners(port: Int): List<Int> {
        val hexPort = port.toString(16).uppercase().padStart(4, '0')
        val inodes = mutableSetOf<String>()
        for (table in listOf("/proc/net/tcp", "/proc/net/tcp6")) {
            try {
                File(table).readLines().drop(1).forEach { line ->
                    // local_address 形如 0100007F:0FA1，state 0A = LISTEN。
                    val parts = line.trim().split(Regex("\\s+"))
                    if (parts.size < 10) return@forEach
                    val local = parts[1]
                    val state = parts[3]
                    if (!local.endsWith(":$hexPort") || state != "0A") return@forEach
                    if (!local.startsWith("0100007F:") && !local.startsWith("0000000000000000000000000100007F:")) return@forEach
                    inodes.add(parts[9])
                }
            } catch (_: Exception) {
            }
        }
        if (inodes.isEmpty()) return emptyList()
        val holders = mutableSetOf<Int>()
        File("/proc").listFiles().orEmpty().forEach { entry ->
            val pid = entry.name.toIntOrNull() ?: return@forEach
            try {
                File(entry, "fd").listFiles().orEmpty().forEach { fd ->
                    val target = try {
                        Os.readlink(fd.absolutePath)
                    } catch (_: Exception) {
                        return@forEach
                    }
                    // 精确匹配 socket:[inode]，子串匹配会把 123 误认成 1234。
                    if (target.startsWith("socket:[") && target.endsWith("]")) {
                        if (inodes.contains(target.removePrefix("socket:[").removeSuffix("]"))) {
                            holders.add(pid)
                        }
                    }
                }
            } catch (_: Exception) {
            }
        }
        return holders.toList()
    }

    /**
     * 持有者身份备注：是我们的 runner 还是外来程序，供报错时点名。
     * 返回 null 表示进程已消失或读不到信息。
     */
    fun describeHolder(pid: Int, runnerPath: String): String? {
        if (!isPidAlive(pid)) return null
        val kind = if (isOurProot(pid, runnerPath)) "本应用残留" else "其它程序"
        return "$kind(pid $pid)"
    }
}
