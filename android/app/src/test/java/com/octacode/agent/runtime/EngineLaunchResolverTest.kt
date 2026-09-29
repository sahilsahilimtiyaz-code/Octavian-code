package com.octacode.agent.runtime

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 引擎启动档的纯决策测试：候选排序、回退生成、预检。
 *
 * 编排本身（EngineLaunchResolver.launchEngine）要 Context 与真子进程，
 * 上不了 JVM 单测——因此所有“做决定”的部分都必须是纯函数，在这里穷举；
 * 编排只负责按顺序执行它们（CI 的真机构建负责集成）。
 */
class EngineLaunchResolverTest {
    private fun binds(vararg targets: String) = targets.map { ProotBindMount(it) }

    @Test
    fun `candidates order seccomp-off first and proc second`() {
        val candidates = engineProfileCandidates(
            systemBinds = binds("/etc/resolv.conf"),
            mailboxBinds = binds("/mnt/inbox"),
            storageBinds = binds("/mnt/user/0"),
        )
        assertEquals(4, candidates.size)
        // seccomp 关在前（Bun 的 JIT 在部分机型 filter 下直接 SIGSEGV），/proc 挂在前（标准形态）。
        assertEquals(true, candidates[0].disableSeccomp)
        assertTrue(candidates[0].bindMounts.any { it.target == "/proc" })
        assertEquals(true, candidates[1].disableSeccomp)
        assertTrue(candidates[1].bindMounts.none { it.target == "/proc" })
        assertEquals(false, candidates[2].disableSeccomp)
        assertTrue(candidates[2].bindMounts.any { it.target == "/proc" })
        assertEquals(false, candidates[3].disableSeccomp)
        assertTrue(candidates[3].bindMounts.none { it.target == "/proc" })
        // 可选绑定在每一档都跟随，不因档位丢失。
        candidates.forEach { profile ->
            assertTrue(profile.bindMounts.any { it.target == "/mnt/inbox" })
            assertTrue(profile.bindMounts.any { it.target == "/mnt/user/0" })
        }
    }

    @Test
    fun `proc fallback appears exactly once and only when bound`() {
        val withProc = ProotLaunchProfile(
            disableSeccomp = true,
            bindMounts = binds("/dev", "/proc", "/mnt/inbox"),
        )
        val result = ProcessProbeResult(exitCode = 1, timedOut = false, output = "", startError = null)
        val fallbacks = engineFallbacks(withProc, result)
        val procDropped = fallbacks.filter { profile -> profile.bindMounts.none { it.target == "/proc" } }
        assertEquals(1, procDropped.size)
        // 摘掉 /proc 之外，其余原样保留（不顺手丢 mailbox）。
        assertTrue(procDropped[0].bindMounts.any { it.target == "/mnt/inbox" })
        assertEquals(true, procDropped[0].disableSeccomp)

        val withoutProc = ProotLaunchProfile(
            disableSeccomp = true,
            bindMounts = binds("/dev", "/mnt/inbox"),
        )
        val again = engineFallbacks(withoutProc, result)
        assertTrue(again.none { profile -> profile.bindMounts.none { it.target == "/proc" } && profile.bindMounts.size == 2 })
    }

    @Test
    fun `preflight rejects missing root, missing system dir and missing cli`() {
        val empty = Files.createTempDirectory("engine-root-missing").toFile()
        empty.deleteRecursively()
        assertThrows(RuntimeFailure::class.java) {
            validateEngineGuest(empty, "usr/local/bin/opencode", "opencode")
        }

        val root = Files.createTempDirectory("engine-root").toFile()
        try {
            // 缺 /root 系统目录。
            assertThrows(RuntimeFailure::class.java) {
                validateEngineGuest(root, "usr/local/bin/opencode", "opencode")
            }
            File(root, "root").mkdirs()
            // 缺 CLI 本体。
            val failure = assertThrows(RuntimeFailure::class.java) {
                validateEngineGuest(root, "usr/local/bin/opencode", "opencode")
            }
            assertEquals("AGENT_ENGINE_MISSING", failure.code)
            // 空文件与不可读同样拒绝。
            File(root, "usr/local/bin").mkdirs()
            val stub = File(root, "usr/local/bin/opencode")
            stub.createNewFile()
            assertThrows(RuntimeFailure::class.java) {
                validateEngineGuest(root, "usr/local/bin/opencode", "opencode")
            }
            stub.writeText("#!/bin/sh\nexit 0\n")
            validateEngineGuest(root, "usr/local/bin/opencode", "opencode")
        } finally {
            root.deleteRecursively()
        }
    }
}
