package com.octacode.agent.runtime

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 清单可选节 `agentClis` 的用例：纯 `java.net` + 正则判定，不碰 Android API，
 * 因此可以在 JVM 单测里直接跑（整份 `RuntimeManifest.parse` 要过架构检查，
 * 在单测环境里没有 `Build`，故这里只覆盖与架构无关的 Agent 节）。
 */
class RuntimeAgentManifestTest {
    private fun entry(
        name: String = "agy",
        version: String = "1.2.12",
        url: String = "https://github.com/google-antigravity/antigravity-cli/releases/download/1.2.12/agy_cli_linux_arm64.tar.gz",
        sha256: String = "a".repeat(64),
        compressedBytes: Long = 57_000_000L,
        extractedBytes: Long = 200_000_000L,
        binary: String = "agy",
        viaNode: Boolean = false,
    ): JSONObject = JSONObject()
        .put("name", name)
        .put("version", version)
        .put("url", url)
        .put("sha256", sha256)
        .put("compressedBytes", compressedBytes)
        .put("extractedBytes", extractedBytes)
        .put("binary", binary)
        .put("viaNode", viaNode)

    @Test
    fun `absent or empty agent section means no downloadable agents`() {
        assertTrue(RuntimeManifest.parseAgentClis(null, "github.com").isEmpty())
        assertTrue(RuntimeManifest.parseAgentClis(JSONArray(), "github.com").isEmpty())
    }

    @Test
    fun `accepts a well formed agy entry`() {
        val agents = RuntimeManifest.parseAgentClis(JSONArray().put(entry()), "github.com")
        assertEquals(1, agents.size)
        val agent = agents.single()
        assertEquals("agy", agent.name)
        assertEquals("1.2.12", agent.version)
        assertEquals("agy", agent.binary)
        assertEquals(false, agent.viaNode)
        assertEquals("opt/agent-agy", AgentCliArtifact.sandboxDir("agy"))
        assertEquals("usr/local/bin/agy", AgentCliArtifact.wrapperPath("agy"))
    }

    @Test
    fun `rejects duplicate names`() {
        val failure = assertThrows(RuntimeFailure::class.java) {
            RuntimeManifest.parseAgentClis(JSONArray().put(entry()).put(entry()), "github.com")
        }
        assertEquals("MANIFEST_INVALID", failure.code)
    }

    @Test
    fun `rejects more than eight agents`() {
        val array = JSONArray()
        repeat(RuntimeLimits.MAX_AGENT_CLIS + 1) { index ->
            array.put(entry(name = "agent-$index"))
        }
        val failure = assertThrows(RuntimeFailure::class.java) {
            RuntimeManifest.parseAgentClis(array, "github.com")
        }
        assertEquals("MANIFEST_INVALID", failure.code)
    }

    @Test
    fun `rejects bad names versions binaries and flags`() {
        listOf(
            entry(name = "Agy"),
            entry(name = "agy!"),
            entry(name = ""),
            entry(version = "1.2 12"),
            entry(binary = "../agy"),
            entry(binary = "sub/agy"),
            entry(binary = ""),
        ).forEach { bad ->
            val failure = assertThrows(RuntimeFailure::class.java) {
                RuntimeManifest.parseAgentClis(JSONArray().put(bad), "github.com")
            }
            assertEquals("MANIFEST_INVALID", failure.code)
        }
        val viaNodeJs = entry(name = "helper", binary = "helper.js", viaNode = true)
        assertEquals(1, RuntimeManifest.parseAgentClis(JSONArray().put(viaNodeJs), "github.com").size)
        val viaNodeNative = entry(name = "helper", binary = "helper", viaNode = true)
        val failure = assertThrows(RuntimeFailure::class.java) {
            RuntimeManifest.parseAgentClis(JSONArray().put(viaNodeNative), "github.com")
        }
        assertEquals("MANIFEST_INVALID", failure.code)
    }

    @Test
    fun `rejects insecure urls digests sizes and foreign hosts`() {
        // http 明文、私有地址、坏摘要、超限尺寸、与清单不同主机一律拒绝。
        val http = entry(url = "http://github.com/a/b.tar.gz")
        assertEquals("URL_INVALID", assertThrows(RuntimeFailure::class.java) {
            RuntimeManifest.parseAgentClis(JSONArray().put(http), "github.com")
        }.code)
        val foreign = entry(url = "https://example.com/a/b.tar.gz")
        assertEquals("DOWNLOAD_HOST_NOT_ALLOWED", assertThrows(RuntimeFailure::class.java) {
            RuntimeManifest.parseAgentClis(JSONArray().put(foreign), "github.com")
        }.code)
        val badDigest = entry(sha256 = "xyz")
        assertThrows(RuntimeFailure::class.java) {
            RuntimeManifest.parseAgentClis(JSONArray().put(badDigest), "github.com")
        }
        val tooBig = entry(compressedBytes = RuntimeLimits.MAX_AGENT_COMPRESSED_BYTES + 1)
        assertEquals("MANIFEST_SIZE_INVALID", assertThrows(RuntimeFailure::class.java) {
            RuntimeManifest.parseAgentClis(JSONArray().put(tooBig), "github.com")
        }.code)
    }

    @Test
    fun `generates deterministic wrappers`() {
        val native = AgentCliArtifact.wrapperBytes("agent-agy/agy", false)
        assertEquals("#!/bin/sh\nexec /opt/agent-agy/agy \"\$@\"\n", native.toString(Charsets.UTF_8))
        val node = AgentCliArtifact.wrapperBytes("agent-helper/helper.js", true)
        assertEquals(
            "#!/bin/sh\nexec /opt/node/bin/node /opt/agent-helper/helper.js \"\$@\"\n",
            node.toString(Charsets.UTF_8),
        )
    }
}
