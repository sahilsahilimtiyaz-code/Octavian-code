package com.octacode.agent.runtime

import java.io.File
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Before
import org.junit.Test

/**
 * 每个运行服务独立的 PRoot 临时目录（[RuntimeCommand.prootTmpDirectory]）。
 *
 * 隔离的意义：终端、Harness、自检、插件管理与各引擎**并发**起 PRoot，共用一个
 * `proot-tmp` 时一个服务的残留清理会波及另一个服务正在用的临时文件；分目录之后
 * 归属可定位、清理互不干扰。
 */
class RuntimeCommandTmpDirectoryTest {
    private lateinit var cacheDir: File

    @Before
    fun setUp() {
        cacheDir = Files.createTempDirectory("octacode-cache").toFile()
    }

    @After
    fun tearDown() {
        cacheDir.deleteRecursively()
    }

    @Test
    fun `each service tag gets its own directory under proot-tmp`() {
        val harness = RuntimeCommand.prootTmpDirectory(cacheDir, "harness")
        val terminal = RuntimeCommand.prootTmpDirectory(cacheDir, "terminal")
        val selfcheck = RuntimeCommand.prootTmpDirectory(cacheDir, "selfcheck")
        val plugin = RuntimeCommand.prootTmpDirectory(cacheDir, "plugin")
        val engine = RuntimeCommand.prootTmpDirectory(cacheDir, "engine-opencode")

        val paths = listOf(harness, terminal, selfcheck, plugin, engine)
        assertEquals(paths.size, paths.map { it.absolutePath }.toSet().size)
        paths.forEach { dir ->
            assertEquals(File(cacheDir, "proot-tmp"), dir.parentFile)
            assertNotEquals("proot-tmp", dir.name)
        }
    }

    @Test
    fun `engine tags are per engine`() {
        val opencode = RuntimeCommand.prootTmpDirectory(cacheDir, "engine-opencode")
        val codex = RuntimeCommand.prootTmpDirectory(cacheDir, "engine-codex")

        assertNotEquals(opencode, codex)
        assertEquals("engine-opencode", opencode.name)
        assertEquals("engine-codex", codex.name)
    }

    @Test
    fun `path traversal via tag is rejected`() {
        listOf("../escape", "a/b", "..", ".", "harness/../../x", "", "HARNESS", "with space", "a".repeat(33))
            .forEach { tag ->
                assertThrows(RuntimeFailure::class.java) {
                    RuntimeCommand.prootTmpDirectory(cacheDir, tag)
                }
            }
    }

    @Test
    fun `a rejected tag never creates the directory`() {
        assertThrows(RuntimeFailure::class.java) {
            RuntimeCommand.prootTmpDirectory(cacheDir, "../escape")
        }
        assertEquals(false, File(cacheDir, "escape").exists())
    }
}
