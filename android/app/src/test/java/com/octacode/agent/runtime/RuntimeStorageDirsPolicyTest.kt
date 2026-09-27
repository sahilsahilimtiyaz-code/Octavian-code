package com.octacode.agent.runtime

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 目录白名单**纯策略**的穷举用例：不接触文件系统，也不依赖 Android API。
 *
 * 覆盖 `docs/存储权限与导入落点.md` §3.2 的每一条判定：document id → 相对路径的映射规则、
 * 非 `primary:` 卷的拒绝、以及规范路径的准入规则（根、`Android/`、应用私有目录、
 * 符号链接逃逸、路径结构、PRoot 绑定源字符集）。
 */
class RuntimeStorageDirsPolicyTest {
    private val root = RuntimeStorageDirsLayout.PUBLIC_STORAGE

    // ---------- document id → 相对路径 ----------

    @Test
    fun `maps primary volume document ids to relative paths`() {
        assertEquals("Documents/Foo", RuntimeStorageDirsPolicy.relativePathOfDocumentId("primary:Documents/Foo"))
        assertEquals("Download", RuntimeStorageDirsPolicy.relativePathOfDocumentId("primary:Download"))
        assertEquals("a/b/c", RuntimeStorageDirsPolicy.relativePathOfDocumentId("primary:a/b/c"))
        // 少数 ROM 的提供方给出前导 `/` 或尾部分隔符：都是无歧义归一化。
        assertEquals("Documents/Foo", RuntimeStorageDirsPolicy.relativePathOfDocumentId("primary:/Documents/Foo"))
        assertEquals("Documents/Foo", RuntimeStorageDirsPolicy.relativePathOfDocumentId("primary:Documents/Foo/"))
        assertEquals("Documents/Foo", RuntimeStorageDirsPolicy.relativePathOfDocumentId("primary://Documents/Foo//"))
    }

    @Test
    fun `rejects non primary volumes with a dedicated code`() {
        listOf(
            "1234-5678:Documents/Foo",
            "sdcard:Download",
            "0000-0000:DCIM",
            "com.android.externalstorage.documents:Download",
            "home:Documents",
            "raw:/storage/emulated/0",
        ).forEach { documentId ->
            val failure = assertThrows(RuntimeFailure::class.java) {
                RuntimeStorageDirsPolicy.relativePathOfDocumentId(documentId)
            }
            assertEquals("输入=$documentId", StorageDirCodes.VOLUME_UNSUPPORTED, failure.code)
        }
    }

    @Test
    fun `rejects the shared storage root`() {
        listOf("primary:", "primary:/", "primary://").forEach { documentId ->
            val failure = assertThrows(RuntimeFailure::class.java) {
                RuntimeStorageDirsPolicy.relativePathOfDocumentId(documentId)
            }
            assertEquals("输入=$documentId", StorageDirCodes.ROOT_REJECTED, failure.code)
        }
    }

    @Test
    fun `rejects malformed document ids`() {
        val tooDeep = "primary:" + (1..(RuntimeStorageDirsLimits.MAX_PATH_DEPTH + 1)).joinToString("/") { "d$it" }
        val tooLong = "primary:" + "x".repeat(RuntimeStorageDirsLimits.MAX_RELATIVE_PATH_CHARS + 1)
        val longSegment = "primary:" + "y".repeat(RuntimeStorageDirsLimits.MAX_COMPONENT_CHARS + 1)
        listOf(
            "",
            "no-volume-separator",
            ":Documents",
            "primary:\\Documents",
            "primary:a//b",
            "primary:a/./b",
            "primary:a/../../etc",
            "primary:..",
            "primary:a\u0000b",
            "primary:a\nb",
            longSegment,
            tooDeep,
            tooLong,
        ).forEach { documentId ->
            val failure = assertThrows(RuntimeFailure::class.java) {
                RuntimeStorageDirsPolicy.relativePathOfDocumentId(documentId)
            }
            assertEquals("输入=" + documentId.take(32), StorageDirCodes.DOCUMENT_ID_INVALID, failure.code)
        }
    }

    @Test
    fun `display name is the last path segment and is truncated`() {
        assertEquals("Foo", RuntimeStorageDirsPolicy.displayNameOf("Documents/Foo"))
        assertEquals("Download", RuntimeStorageDirsPolicy.displayNameOf("Download"))
        assertEquals(
            RuntimeStorageDirsLimits.MAX_DISPLAY_NAME_CHARS,
            RuntimeStorageDirsPolicy.displayNameOf("a/" + "z".repeat(200)).length,
        )
    }

    // ---------- 规范路径的准入规则 ----------

    @Test
    fun `accepts ordinary directories under the public storage root`() {
        listOf(
            "$root/Download",
            "$root/Documents/Project",
            "$root/DCIM/Camera",
            "$root/a-b_c.d/e",
        ).forEach { path ->
            RuntimeStorageDirsPolicy.requireCanonicalPath(path)
        }
    }

    @Test
    fun `rejects paths outside the shared storage root`() {
        listOf(
            "$root",
            "/sdcard",
            "/sdcard/Download",
            "/storage/emulated/0extra/Download",
            "/storage/emulated/1/Download",
            "/mnt/media_rw/1234-5678/Download",
            "/data/data/com.octacode.agent/files",
            "/data/local/tmp",
            "/storage",
        ).forEach { path ->
            val failure = assertThrows(RuntimeFailure::class.java) {
                RuntimeStorageDirsPolicy.requireCanonicalPath(path)
            }
            val expected = if (path == root) StorageDirCodes.ROOT_REJECTED else StorageDirCodes.OUTSIDE_PUBLIC
            assertEquals("输入=$path", expected, failure.code)
        }
    }

    @Test
    fun `rejects android and app private directories`() {
        listOf(
            "$root/Android",
            "$root/Android/data",
            "$root/Android/obb",
            "$root/Android/media",
        ).forEach { path ->
            val failure = assertThrows(RuntimeFailure::class.java) {
                RuntimeStorageDirsPolicy.requireCanonicalPath(path)
            }
            val expected = if (path.startsWith("$root/Android/data") || path.startsWith("$root/Android/obb")) {
                StorageDirCodes.PRIVATE_REJECTED
            } else {
                StorageDirCodes.ANDROID_REJECTED
            }
            assertEquals("输入=$path", expected, failure.code)
        }
    }

    @Test
    fun `rejects malformed canonical paths`() {
        listOf(
            "",
            "relative/path",
            "storage/emulated/0/Download",
            "$root/Download/../Documents",
            "$root/./Download",
            "$root//Download",
            "$root/Download/",
            "$root\\Download",
            "$root/Download\u0000",
            "$root/" + (1..(RuntimeStorageDirsLimits.MAX_PATH_DEPTH + 2)).joinToString("/") { "d$it" },
        ).forEach { path ->
            val failure = assertThrows(RuntimeFailure::class.java) {
                RuntimeStorageDirsPolicy.requireCanonicalPath(path)
            }
            assertEquals("输入=" + path.take(48), StorageDirCodes.PATH_INVALID, failure.code)
        }
    }

    /**
     * 非 ASCII 与带空格的目录名必须被**在选择当下**拒绝。
     *
     * 理由不是洁癖：`RuntimeCommand` 的绑定参数是字符白名单正则，这类路径会让 `prootArgv` 抛
     * `RUNNER_ARGUMENT_INVALID`，最终以「PRoot 起不来」的形式炸掉整个会话——比拒绝严重得多。
     * 这条用例同时钉住了「白名单放行的路径一定能通过绑定校验」这个不变量。
     */
    @Test
    fun `rejects directory names the runtime cannot bind`() {        listOf(
            "$root/My Documents",
            "$root/我的文档",
            "$root/Download/子目录",
            "$root/Download:2",
        ).forEach { path ->
            val failure = assertThrows(RuntimeFailure::class.java) {
                RuntimeStorageDirsPolicy.requireCanonicalPath(path)
            }
            assertEquals("输入=$path", StorageDirCodes.UNBINDABLE, failure.code)
            assertFalse(RuntimeCommand.isSafeAbsolutePath(path))
        }
        assertTrue(RuntimeCommand.isSafeAbsolutePath("$root/Download"))
    }

    @Test
    fun `every accepted path stays bindable by the runtime`() {
        listOf("$root/Download", "$root/Documents/Project", "$root/DCIM/Camera").forEach { path ->
            RuntimeStorageDirsPolicy.requireCanonicalPath(path)
            assertTrue(path, RuntimeCommand.isSafeAbsolutePath(path))
        }
    }

    // ---------- 带文件系统探针的整条判定链 ----------

    @Test
    fun `resolves a selected tree to its canonical host path`() {
        val fileSystem = FakeStorageDirFileSystem(
            directories = setOf("$root/Documents/Project"),
        )
        assertEquals(
            "$root/Documents/Project",
            RuntimeStorageDirsPolicy.resolveSelectedDirectory("primary:Documents/Project", fileSystem),
        )
    }

    @Test
    fun `follows symlinks and rejects an escape out of the shared storage`() {
        val fileSystem = FakeStorageDirFileSystem(
            canonical = mapOf("$root/Documents/Link" to "/data/local/tmp"),
            directories = setOf("/data/local/tmp"),
        )
        val failure = assertThrows(RuntimeFailure::class.java) {
            RuntimeStorageDirsPolicy.resolveSelectedDirectory("primary:Documents/Link", fileSystem)
        }
        assertEquals(StorageDirCodes.OUTSIDE_PUBLIC, failure.code)
    }

    @Test
    fun `rejects a selection that is not a real directory`() {
        // `/sdcard` 是符号链接的经典形态：canonical 解出来是真实路径，但自身不是真实目录。
        val symlinkOnly = FakeStorageDirFileSystem(directories = emptySet())
        val failure = assertThrows(RuntimeFailure::class.java) {
            RuntimeStorageDirsPolicy.resolveSelectedDirectory("primary:Download", symlinkOnly)
        }
        assertEquals(StorageDirCodes.NOT_A_DIRECTORY, failure.code)
    }

    @Test
    fun `reports an unresolvable path when canonicalization fails`() {
        val fileSystem = FakeStorageDirFileSystem(failCanonicalFor = setOf("$root/Download"))
        val failure = assertThrows(RuntimeFailure::class.java) {
            RuntimeStorageDirsPolicy.resolveSelectedDirectory("primary:Download", fileSystem)
        }
        assertEquals(StorageDirCodes.UNRESOLVED, failure.code)
    }

    @Test
    fun `rejects an unreadable selected directory`() {
        val fileSystem = FakeStorageDirFileSystem(
            directories = setOf("$root/Download"),
            unreadable = setOf("$root/Download"),
        )
        val failure = assertThrows(RuntimeFailure::class.java) {
            RuntimeStorageDirsPolicy.resolveSelectedDirectory("primary:Download", fileSystem)
        }
        assertEquals(StorageDirCodes.UNREADABLE, failure.code)
    }

    // ---------- 外部存储卷（SD 卡 / OTG） ----------

    @Test
    fun `resolves an external volume tree through the volume root map`() {
        val fileSystem = FakeStorageDirFileSystem(
            directories = setOf("/storage/3465-6364/Download"),
            volumeRoots = mapOf("3465-6364" to "/storage/3465-6364"),
        )
        assertEquals(
            "/storage/3465-6364/Download",
            RuntimeStorageDirsPolicy.resolveSelectedDirectory("3465-6364:Download", fileSystem),
        )
    }

    @Test
    fun `rejects an external volume the system cannot locate`() {
        // 卷映射表里没有这一项（已弹出、不支持的提供方）：拒绝比猜错好。
        val fileSystem = FakeStorageDirFileSystem(directories = setOf("/storage/3465-6364/Download"))
        val failure = assertThrows(RuntimeFailure::class.java) {
            RuntimeStorageDirsPolicy.resolveSelectedDirectory("3465-6364:Download", fileSystem)
        }
        assertEquals(StorageDirCodes.VOLUME_UNSUPPORTED, failure.code)
    }

    @Test
    fun `rejects the external volume root itself`() {
        val fileSystem = FakeStorageDirFileSystem(
            directories = setOf("/storage/3465-6364"),
            volumeRoots = mapOf("3465-6364" to "/storage/3465-6364"),
        )
        val failure = assertThrows(RuntimeFailure::class.java) {
            // 卷内路径为空 → 归一化后命中 ROOT_REJECTED（整卷绑定等同于旧的整体绑定）。
            RuntimeStorageDirsPolicy.resolveSelectedDirectory("3465-6364:", fileSystem)
        }
        assertEquals(StorageDirCodes.ROOT_REJECTED, failure.code)
    }

    @Test
    fun `rejects android private directories on external volumes`() {
        val fileSystem = FakeStorageDirFileSystem(
            directories = setOf("/storage/3465-6364/Android/data/com.example"),
            volumeRoots = mapOf("3465-6364" to "/storage/3465-6364"),
        )
        val failure = assertThrows(RuntimeFailure::class.java) {
            RuntimeStorageDirsPolicy.resolveSelectedDirectory("3465-6364:Android/data/com.example", fileSystem)
        }
        assertEquals(StorageDirCodes.PRIVATE_REJECTED, failure.code)
    }

    @Test
    fun `revalidates stored external entries without the volume map`() {
        // 重绑旧条目时只有绝对路径：按路径派生所属卷根，同一套段规则。
        RuntimeStorageDirsPolicy.requireCanonicalPath("/storage/3465-6364/Download")
        RuntimeStorageDirsPolicy.requireCanonicalPath("/storage/3465-6364/Documents/Project")
        listOf(
            "/storage/3465-6364" to StorageDirCodes.ROOT_REJECTED,
            "/storage/3465-6364/Android/obb" to StorageDirCodes.PRIVATE_REJECTED,
            "/storage/3465-6364/Android/media" to StorageDirCodes.ANDROID_REJECTED,
            "/storage/emulated/Download" to StorageDirCodes.OUTSIDE_PUBLIC,
            "/storage/self/primary/Download" to StorageDirCodes.OUTSIDE_PUBLIC,
            "/mnt/media_rw/3465-6364/Download" to StorageDirCodes.OUTSIDE_PUBLIC,
        ).forEach { (path, expected) ->
            val failure = assertThrows(RuntimeFailure::class.java) {
                RuntimeStorageDirsPolicy.requireCanonicalPath(path)
            }
            assertEquals("输入=$path", expected, failure.code)
        }
    }

    @Test
    fun `rejects a symlink escape out of the external volume`() {
        val fileSystem = FakeStorageDirFileSystem(
            canonical = mapOf("/storage/3465-6364/Link" to "/data/local/tmp"),
            directories = setOf("/data/local/tmp"),
            volumeRoots = mapOf("3465-6364" to "/storage/3465-6364"),
        )
        val failure = assertThrows(RuntimeFailure::class.java) {
            RuntimeStorageDirsPolicy.resolveSelectedDirectory("3465-6364:Link", fileSystem)
        }
        assertEquals(StorageDirCodes.OUTSIDE_PUBLIC, failure.code)
    }
}

/**
 * 假文件系统：把「哪条路径是真实目录、符号链接解析到哪」变成显式输入，
 * 于是「符号链接逃逸」「目录被删」这些分支可以在 JVM 单测里穷举，而不是只能靠真机试。
 */
internal class FakeStorageDirFileSystem(
    override val publicStorageRoot: String = RuntimeStorageDirsLayout.PUBLIC_STORAGE,
    var supported: Boolean = true,
    var accessible: Boolean = true,
    private val canonical: Map<String, String> = emptyMap(),
    directories: Set<String> = emptySet(),
    unreadable: Set<String> = emptySet(),
    private val failCanonicalFor: Set<String> = emptySet(),
    private val volumeRoots: Map<String, String> = emptyMap(),
) : StorageDirFileSystem {
    private val directories = directories.toMutableSet()
    private val unreadable = unreadable.toMutableSet()

    fun addDirectory(path: String) {
        directories += path
        unreadable -= path
    }

    fun removeDirectory(path: String) {
        directories -= path
    }

    fun makeUnreadable(path: String) {
        unreadable += path
    }

    override fun isFeatureSupported(): Boolean = supported

    override fun isSharedStorageAccessible(): Boolean = accessible

    override fun canonicalPath(path: String): String? =
        if (path in failCanonicalFor) null else canonical[path] ?: path

    override fun volumeRoot(volumeId: String): String? = volumeRoots[volumeId]

    override fun isRealDirectoryNoFollow(path: String): Boolean = path in directories

    override fun isReadableDirectory(path: String): Boolean = path in directories && path !in unreadable
}
