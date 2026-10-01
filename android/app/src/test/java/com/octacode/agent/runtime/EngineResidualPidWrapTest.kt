package com.octacode.agent.runtime

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 引擎 pidfile 怎么落盘：**不**从 `Process` 手里反查 pid。
 *
 * `android.jar`（API 35）里的 `java.lang.Process` 没有 `pid()`，直接调用是编译错误——
 * CI 上真正拦住构建的就是那一行；反射取私有字段又会被 API 28+ 的 hidden API 限制挡回来。
 * Harness 侧早就有解法（`RuntimeSupervisor.harnessLaunchArgv`）：包一层
 * `/system/bin/sh`，让 shell 先把自己的 pid 写进 `DSH_PIDFILE` 再 `exec` 原入口，
 * `exec` 不换进程，所以落盘的就是最终 proot 的 pid。
 *
 * 这里锁住包装的形状：原 argv 一个不少、`$$` 与环境条目都在位、空 argv 不被凭空包一层
 * （包了也起不来，还会把真正的错误信息换成 shell 的）。
 */
class EngineResidualPidWrapTest {
    private val original = listOf("/data/local/tmp/octa-runner", "-r", "/data/data/root", "/usr/bin/env")

    @Test
    fun `包装后原 argv 完整落在 shell 的位置参数里`() {
        val wrapped = EngineResidual.pidWritingLaunchArgv(original)

        assertEquals("/system/bin/sh", wrapped[0])
        assertEquals("-c", wrapped[1])
        // 前三个是 shell 自己的，剩下的必须原封不动是原来的 argv。
        assertEquals(original, wrapped.drop(3))
    }

    @Test
    fun `shell 脚本写自己的 pid、从环境取路径、再 exec 原入口`() {
        val script = EngineResidual.pidWritingLaunchArgv(original)[2]

        assertTrue("必须写 \$\$：那是 shell 自己的 pid，exec 之后仍然是它", script.contains("\$\$"))
        assertTrue("pidfile 路径只能走环境条目，不能进命令行", script.contains(EngineResidual.PID_FILE_ENV))
        assertTrue("必须 exec 原入口，否则落盘的 pid 与真正干活的进程对不上", script.contains("exec"))
    }

    @Test
    fun `空 argv 原样返回，不凭空包一层 shell`() {
        assertEquals(emptyList<String>(), EngineResidual.pidWritingLaunchArgv(emptyList()))
    }
}
