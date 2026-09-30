package com.octacode.agent.runtime

import java.io.File
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `-r` 根路径必须**规范化**：Android 上 `/data/user/0/<pkg>` 是指向 `/data/data/<pkg>`
 * 的符号链接，PRoot 用给定的根串做宿主路径前缀剥离，而 `chdir` 之后内核给出的 cwd
 * 是解析过的规范路径 —— 两者对不上时前缀剥离失效，访客看到宿主绝对路径。
 *
 * 这里用临时目录里的**符号链接**复现同样的形状（symlink → 真实目录），
 * 断言 [RuntimeCommand.canonicalPathOrSelf] 返回的是解析后的真实路径。
 */
class RuntimeCommandCanonicalPathTest {
    private val scratch = Files.createTempDirectory("octacode-canonical").toFile()

    @After
    fun tearDown() {
        scratch.deleteRecursively()
    }

    @Test
    fun `symlinked root resolves to the real path`() {
        val real = File(scratch, "data-data").apply { mkdirs() }
        val link = File(scratch, "data-user-0")
        Files.createSymbolicLink(link.toPath(), real.toPath())

        val resolved = RuntimeCommand.canonicalPathOrSelf(link)

        assertEquals(real.canonicalPath, resolved)
        assertFalse("符号链接必须被解析掉", resolved.contains("data-user-0"))
        assertTrue(resolved.endsWith("data-data"))
    }

    @Test
    fun `symlinked parent with a not-yet-existing child still resolves the parent`() {
        val real = File(scratch, "real-root").apply { mkdirs() }
        val link = File(scratch, "link-root")
        Files.createSymbolicLink(link.toPath(), real.toPath())
        val child = File(link, "current") // 还不存在的根目录

        val resolved = RuntimeCommand.canonicalPathOrSelf(child)

        assertEquals(File(real, "current").canonicalPath, resolved)
        assertFalse(resolved.contains("link-root"))
    }

    @Test
    fun `a plain absolute path passes through unchanged`() {
        val plain = File(scratch, "plain/current")

        assertEquals(plain.canonicalPath, RuntimeCommand.canonicalPathOrSelf(plain))
    }

    @Test
    fun `an already-canonical path is stable`() {
        val real = File(scratch, "stable").apply { mkdirs() }

        val once = RuntimeCommand.canonicalPathOrSelf(real)
        val twice = RuntimeCommand.canonicalPathOrSelf(File(once))

        assertEquals(once, twice)
        assertEquals(real.canonicalPath, once)
    }

    @Test
    fun `never throws for an unreadable-looking path`() {
        // 规范化失败必须退回原路径而不是炸掉启动链路 —— 这里至少保证不抛异常。
        val missing = File("/nonexistent-octacode-path-48879/current")

        val resolved = RuntimeCommand.canonicalPathOrSelf(missing)
        assertTrue(resolved.startsWith("/"))
    }
}
