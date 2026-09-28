package com.octacode.agent.runtime

import android.system.ErrnoException
import android.system.Os
import java.io.File
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.URL
import java.nio.file.Files
import java.nio.file.StandardOpenOption
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.TimeUnit

/**
 * 本机 Agent 服务（`opencode serve`）的启动、探活与停止。
 *
 * 对标 AndCode 的做法：官方 opencode 二进制跑在访客里，HTTP + SSE 挂在
 * loopback 上，自有聊天界面做它的唯一客户端。dsh Harness 那一套
 * （RuntimeSupervisor + token + Basic 挑战）是另一个独立服务，
 * 两者进程、端口、密码互相独立，只有一条共用的访客环境文件——
 * 因此本服务要求 Harness 未运行时才能启动（否则会踩掉 Harness 的
 * 投递文件；见 [start]）。
 *
 * 秘密策略与仓库其余部分一致：密码取值只存在于访客内 0600 文件
 * （与 Harness 共用 `GUEST_SECRET_ENV_PATH` 落点），argv 里只有路径，
 * 绝不出现赋值形态。
 */
class AgentEngineServer(private val store: RuntimeStore) {
    private val lock = Any()
    private var process: Process? = null
    private var port: Int = DEFAULT_PORT
    /** 本次启动的服务密码：只活在内存里，停服即清零，绝不落盘、不进 argv。 */
    private var serverPassword: String? = null

    /** 只读快照：进程在位且端口能通才算运行中；顺手收敛意外死亡的进程。 */
    fun state(): AgentEngineState = synchronized(lock) {
        val current = process
        if (current != null && !current.isAlive) {
            cleanupLocked()
            return AgentEngineState(running = false, port = port, baseUrl = null)
        }
        val reachable = current?.isAlive == true && isReachable(port)
        return AgentEngineState(
            running = reachable,
            port = port,
            baseUrl = if (reachable) "http://127.0.0.1:$port" else null,
        )
    }

    /**
     * 聊天中继：Web 侧不直接连服务（跨域 + 密码都过不了），由宿主代发 HTTP。
     *
     * 密码只活在内存里：Basic 头在这里拼好，取值不出这个进程；
     * 返回的是服务端 JSON 原文，解析与校验在 TypeScript 侧做。
     */
    fun chatSessions(): String = synchronized(lock) {
        return relay("GET", "/session", null)
    }

    fun chatCreate(title: String): String = synchronized(lock) {
        if (title.isEmpty() || title.length > 120) {
            throw RuntimeFailure("SETTINGS_INVALID", "会话标题无效")
        }
        return relay("POST", "/session", "{\"title\":" + jsonQuote(title) + "}")
    }

    /**
     * 模型目录：`GET /config/providers` 原文透传，解析在 TypeScript 侧做。
     *
     * 不带 directory/workspace 查询：全局模型目录不需要项目作用域；
     * 服务端若要求作用域会 4xx，界面会把原文错误如实展示出来。
     */
    fun agentModels(): String = synchronized(lock) {
        return relay("GET", "/config/providers", null)
    }

    /**
     * 带模型的新会话：`POST /session {title, model?, variant?}`。
     *
     * model 形态为 `provider/model`（与 `opencode run -m` 同一写法）；
     * variant 是模型的 effort 档位，只在目录声明了它时才传。
     * 未知字段服务端按 JSON 惯例忽略——因此 variant 即使在某版本不生效，
     * 最坏情况也只是回到该模型的默认档位，不会建不出会话。
     */
    fun chatCreateWithModel(title: String, modelID: String?, variant: String?): String = synchronized(lock) {
        if (title.isEmpty() || title.length > 120) {
            throw RuntimeFailure("SETTINGS_INVALID", "会话标题无效")
        }
        val body = buildString {
            append("{\"title\":")
            append(jsonQuote(title))
            if (!modelID.isNullOrEmpty()) {
                if (!isModelId(modelID)) {
                    throw RuntimeFailure("SETTINGS_INVALID", "模型标识无效")
                }
                append(",\"model\":")
                append(jsonQuote(modelID))
            }
            if (!variant.isNullOrEmpty()) {
                if (!VARIANT_PATTERN.matches(variant)) {
                    throw RuntimeFailure("SETTINGS_INVALID", "模型档位无效")
                }
                append(",\"variant\":")
                append(jsonQuote(variant))
            }
            append('}')
        }
        return relay("POST", "/session", body)
    }

    fun chatHistory(sessionId: String): String = synchronized(lock) {
        return relay("GET", "/session/" + requireSessionId(sessionId) + "/message", null)
    }

    fun chatSend(sessionId: String, text: String): String = synchronized(lock) {
        if (text.isEmpty() || text.length > MAX_CHAT_TEXT_CHARS) {
            throw RuntimeFailure("SETTINGS_INVALID", "消息内容无效")
        }
        val body = "{\"parts\":[{\"type\":\"text\",\"text\":" + jsonQuote(text) + "}]}"
        return relay("POST", "/session/" + requireSessionId(sessionId) + "/message", body)
    }

    /**
     * 带附件的发送：调用方传已校验的分段（文本 + 文件/图片引用），这里只做
     * 第二道形态检查并拼请求体。附件引用的是落点内的访客路径
     * （`/mnt/inbox/attachments/<名>`），不接受其它位置——访客全盘路径
     * 不能经由聊天口任意读取，这是 v1 的作用域边界。
     */
    fun chatSendParts(sessionId: String, parts: List<AgentChatPart>): String = synchronized(lock) {
        if (parts.isEmpty() || parts.size > MAX_CHAT_PARTS) {
            throw RuntimeFailure("SETTINGS_INVALID", "消息分段无效")
        }
        val body = buildString {
            append("{\"parts\":[")
            parts.forEachIndexed { index, part ->
                if (index > 0) append(',')
                when (part.type) {
                    "text" -> {
                        val text = part.text.orEmpty()
                        if (text.isEmpty() || text.length > MAX_CHAT_TEXT_CHARS) {
                            throw RuntimeFailure("SETTINGS_INVALID", "消息内容无效")
                        }
                        append("{\"type\":\"text\",\"text\":")
                        append(jsonQuote(text))
                        append('}')
                    }
                    "file", "image" -> {
                        val mime = part.mime.orEmpty()
                        val url = part.url.orEmpty()
                        if (!ATTACHMENT_MIME_TYPES.contains(mime) || !isAttachmentGuestPath(url)) {
                            throw RuntimeFailure("SETTINGS_INVALID", "附件引用无效")
                        }
                        append("{\"type\":")
                        append(jsonQuote(part.type))
                        append(",\"mime\":")
                        append(jsonQuote(mime))
                        append(",\"url\":")
                        append(jsonQuote("file://$url"))
                        append(",\"filename\":")
                        append(jsonQuote(url.substringAfterLast('/')))
                        append('}')
                    }
                    else -> throw RuntimeFailure("SETTINGS_INVALID", "消息分段类型无效")
                }
            }
            append("]}")
        }
        return relay("POST", "/session/" + requireSessionId(sessionId) + "/message", body)
    }

    /**
     * 附件落点：base64 → `inbox/attachments/<时间戳>-<名>`，返回访客路径。
     *
     * 文件名只允许字母数字与 `._-`（64 以内）：访客路径要原样进请求体，
     * 宽松的名字在这里就是注入。重名用时间戳前缀天然区分，不覆盖。
     */
    fun stageAttachment(fileName: String, mime: String, dataBase64: String): StagedAttachment = synchronized(lock) {
        if (!ATTACHMENT_NAME_PATTERN.matches(fileName) || !ATTACHMENT_MIME_TYPES.contains(mime)) {
            throw RuntimeFailure("SETTINGS_INVALID", "附件名称或类型无效")
        }
        val bytes = try {
            Base64.getDecoder().decode(dataBase64)
        } catch (_: IllegalArgumentException) {
            throw RuntimeFailure("SETTINGS_INVALID", "附件内容不是合法 base64")
        }
        if (bytes.isEmpty() || bytes.size > MAX_ATTACHMENT_BYTES) {
            throw RuntimeFailure("SETTINGS_INVALID", "附件大小超出限制（8MB）")
        }
        val directory = RuntimeMailbox(store).attachmentDirectory()
        var candidate = File(directory, "${System.currentTimeMillis()}-$fileName")
        var attempts = 0
        while (candidate.exists() && attempts < MAX_STAGE_ATTEMPTS) {
            attempts += 1
            candidate = File(directory, "${System.currentTimeMillis()}-$attempts-$fileName")
        }
        try {
            Files.write(candidate.toPath(), bytes, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)
        } catch (_: Throwable) {
            throw RuntimeFailure("AGENT_ENGINE_REQUEST_FAILED", "附件写入失败")
        }
        return StagedAttachment("${RuntimeMailboxLayout.GUEST_INBOX}/${RuntimeMailboxLayout.ATTACHMENT_DIRECTORY}/${candidate.name}")
    }

    /**
     * 附件读取：只认落点内的访客路径，转 base64 给界面画缩略图。
     *
     * NoFollow 判定在前：落点是共享存储，用户手放的符号链接不能被跟随出去。
     * 落点之外一律拒绝——访客全盘不在 v1 作用域内。
     */
    fun readAttachment(guestPath: String): AttachmentContent = synchronized(lock) {
        if (!isAttachmentGuestPath(guestPath)) {
            throw RuntimeFailure("SETTINGS_INVALID", "附件路径超出范围")
        }
        val name = guestPath.substringAfterLast('/')
        val hostFile = File(RuntimeMailbox(store).attachmentDirectory(), name)
        if (!MailboxTree.isRealRegularFile(hostFile.toPath())) {
            throw RuntimeFailure("AGENT_ENGINE_REQUEST_FAILED", "附件不存在或不可读")
        }
        val bytes = try {
            Files.readAllBytes(hostFile.toPath())
        } catch (_: Throwable) {
            throw RuntimeFailure("AGENT_ENGINE_REQUEST_FAILED", "附件读取失败")
        }
        if (bytes.isEmpty() || bytes.size > MAX_ATTACHMENT_BYTES) {
            throw RuntimeFailure("AGENT_ENGINE_REQUEST_FAILED", "附件大小超出限制（8MB）")
        }
        val mime = mimeForName(name)
        val encoded = Base64.getEncoder().encodeToString(bytes)
        return AttachmentContent(mime, encoded)
    }

    private fun isAttachmentGuestPath(guestPath: String): Boolean {
        val prefix = "${RuntimeMailboxLayout.GUEST_INBOX}/${RuntimeMailboxLayout.ATTACHMENT_DIRECTORY}/"
        if (!guestPath.startsWith(prefix)) return false
        val name = guestPath.removePrefix(prefix)
        return name.isNotEmpty() && !name.contains('/') && ATTACHMENT_NAME_PATTERN.matches(name)
    }

    private fun mimeForName(name: String): String {
        val extension = name.substringAfterLast('.', "").lowercase()
        return EXTENSION_MIME[extension] ?: "application/octet-stream"
    }

    /**
     * 启动 `opencode serve`。
     *
     * 前置：Harness 必须未运行（共用环境文件）；访客必须已安装且自带
     * `/usr/local/bin/opencode`（P3 随整包烘焙）；端口必须空闲。
     */
    fun start(requestedPort: Int? = null): AgentEngineState = synchronized(lock) {
        if (process?.isAlive == true && isReachable(port)) return state()
        stopLocked()
        val targetPort = requestedPort ?: DEFAULT_PORT
        if (targetPort !in 1024..65535) {
            throw RuntimeFailure("SETTINGS_INVALID", "Agent 服务端口超出范围")
        }
        if (!isPortFree(targetPort)) {
            throw RuntimeFailure("AGENT_ENGINE_PORT_BUSY", "Agent 服务端口已被占用")
        }
        if (!File(store.currentRoot, "usr/local/bin/opencode").isFile) {
            throw RuntimeFailure("AGENT_ENGINE_MISSING", "运行时未内置 opencode，请先安装运行时")
        }
        val password = newPassword()
        serverPassword = password
        writeEnvFile(password)
        val entrypoint = listOf(
            "/usr/local/bin/opencode",
            "serve",
            "--hostname",
            "127.0.0.1",
            "--port",
            targetPort.toString(),
        )
        val delivery = RuntimeSecretPolicy.delivery(mapOf(SERVER_PASSWORD_ENV to password), 0)
        // 投递区绑定一起带进访客：附件落点（/mnt/inbox）对 opencode 可见，无需新挂载点。
        // 不可访问时返回空列表（已有语义），服务照常启动，只是附件功能不可用。
        val argv = RuntimeCommand.prootArgv(
            store,
            entrypoint,
            bindMounts = RuntimeMailbox(store).bindMounts(),
            secrets = delivery,
        )
        val logFile = File(store.harnessPidFile.parentFile, "opencode-serve.log")
        val started = try {
            ProcessBuilder(argv)
                .redirectErrorStream(true)
                .redirectOutput(ProcessBuilder.Redirect.appendTo(logFile))
                .start()
        } catch (_: Throwable) {
            store.deleteRuntimeSecrets()
            throw RuntimeFailure("AGENT_ENGINE_START_FAILED", "Agent 服务进程启动失败")
        }
        process = started
        port = targetPort
        try {
            waitForReady(targetPort)
        } catch (failure: RuntimeFailure) {
            stopLocked()
            throw failure
        }
        return state()
    }

    /** 停止服务；幂等，未运行也成功。 */
    fun stop(): AgentEngineState = synchronized(lock) {
        stopLocked()
        return state()
    }

    /**
     * 代发 HTTP：调用前必须已就绪（进程在位 + 端口可达），否则报停止态而不是超时。
     *
     * Basic 用户名固定 `opencode`（与 AndCode 的远端约定一致）；密码是内存里的
     * 本次启动取值。2xx 之外一律按失败抛错（含 401：正常启动后不该出现，
     * 出现了说明密码对不上——那是实现 bug，不是用户能修的）。
     */
    private fun relay(method: String, path: String, body: String?): String {
        val current = process
        val password = serverPassword
        if (current?.isAlive != true || password == null || !isReachable(port)) {
            throw RuntimeFailure("AGENT_ENGINE_STOPPED", "Agent 服务未运行，请先启动")
        }
        var connection: HttpURLConnection? = null
        try {
            connection = URL("http://127.0.0.1:$port$path").openConnection() as HttpURLConnection
            connection.requestMethod = method
            connection.connectTimeout = RELAY_TIMEOUT_MILLIS
            connection.readTimeout = RELAY_TIMEOUT_MILLIS
            connection.instanceFollowRedirects = false
            connection.setRequestProperty("Accept", "application/json")
            val credentials = "opencode:$password"
            val basic = Base64.getEncoder().encodeToString(credentials.toByteArray(Charsets.UTF_8))
            connection.setRequestProperty("Authorization", "Basic $basic")
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            }
            val code = connection.responseCode
            if (code !in 200..299) {
                throw RuntimeFailure("AGENT_ENGINE_REQUEST_FAILED", "Agent 服务返回 $code")
            }
            val stream = connection.inputStream
            return stream.bufferedReader(Charsets.UTF_8).use { it.readText() }.ifEmpty { "null" }
        } catch (failure: RuntimeFailure) {
            throw failure
        } catch (_: Throwable) {
            throw RuntimeFailure("AGENT_ENGINE_REQUEST_FAILED", "Agent 服务请求失败")
        } finally {
            connection?.disconnect()
        }
    }

    private fun requireSessionId(sessionId: String): String {
        if (!SESSION_ID_PATTERN.matches(sessionId)) {
            throw RuntimeFailure("SETTINGS_INVALID", "会话标识无效")
        }
        return sessionId
    }

    /** 模型标识 `provider/model`：两段各含至少一个字母数字，纯符号组合不过。 */
    private fun isModelId(value: String): Boolean {
        val segments = value.split('/')
        return segments.size == 2 &&
            segments.all { MODEL_ID_SEGMENT.matches(it) && MODEL_ID_ALNUM.containsMatchIn(it) }
    }

    /** 最小 JSON 字符串转义：opencode 的 id 与我们拼的正文都经这里进请求体。 */
    private fun jsonQuote(value: String): String = buildString {
        append('"')
        value.forEach { char ->
            when (char) {
                '"' -> append("\\\"")
                '\\' -> append("\\\\")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                else -> if (char.code < 0x20) append("\\u%04x".format(char.code)) else append(char)
            }
        }
        append('"')
    }

    private fun stopLocked() {
        val current = process
        process = null
        if (current != null && current.isAlive) {
            current.destroy()
            try {
                if (!current.waitFor(PROCESS_STOP_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                    current.destroyForcibly()
                    current.waitFor(PROCESS_STOP_TIMEOUT_SECONDS, TimeUnit.SECONDS)
                }
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
                current.destroyForcibly()
            }
        }
        cleanupLocked()
    }

    private fun cleanupLocked() {
        process = null
        serverPassword = null
        store.deleteRuntimeSecrets()
    }

    /** 密码只写文件（0600），与 Harness 的投递文件同形态、同权限。 */
    private fun writeEnvFile(password: String) {
        val file = store.runtimeSecretFile
        try {
            file.parentFile?.mkdirs()
            Files.write(
                file.toPath(),
                RuntimeSecretPolicy.renderEnvironmentFile(mapOf(SERVER_PASSWORD_ENV to password)).toByteArray(Charsets.UTF_8),
                StandardOpenOption.CREATE,
                StandardOpenOption.TRUNCATE_EXISTING,
                StandardOpenOption.WRITE,
            )
            Os.chmod(file.absolutePath, 384 /* 0600 */)
        } catch (_: Throwable) {
            try {
                Os.remove(file.absolutePath)
            } catch (_: ErrnoException) {
                // 写一半的文件不能留：取值残缺比缺文件更难排查。
            }
            throw RuntimeFailure("RUNTIME_CONFIG_FAILED", "Agent 服务凭据投递失败")
        }
    }

    /** 就绪 = 端口上有 HTTP 应答（含 401：设了密码的 serve 对匿名探测就该这么答）。 */
    private fun waitForReady(targetPort: Int) {
        val deadline = System.currentTimeMillis() + START_TIMEOUT_MILLIS
        while (System.currentTimeMillis() < deadline) {
            if (process?.isAlive != true) {
                throw RuntimeFailure("AGENT_ENGINE_START_FAILED", "Agent 服务进程意外退出")
            }
            if (isReachable(targetPort)) return
            try {
                Thread.sleep(PROBE_INTERVAL_MILLIS)
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
                throw RuntimeFailure("AGENT_ENGINE_START_FAILED", "Agent 服务启动被中断")
            }
        }
        throw RuntimeFailure("AGENT_ENGINE_START_FAILED", "Agent 服务启动超时")
    }

    private fun isReachable(targetPort: Int): Boolean {
        var connection: HttpURLConnection? = null
        try {
            connection = URL("http://127.0.0.1:$targetPort/").openConnection() as HttpURLConnection
            connection.connectTimeout = PROBE_TIMEOUT_MILLIS
            connection.readTimeout = PROBE_TIMEOUT_MILLIS
            connection.instanceFollowRedirects = false
            // 任何 HTTP 应答（含 401）都证明服务在位；只有连不上才算没好。
            connection.responseCode
            return true
        } catch (_: Throwable) {
            return false
        } finally {
            connection?.disconnect()
        }
    }

    private fun isPortFree(targetPort: Int): Boolean {
        try {
            ServerSocket().apply {
                reuseAddress = true
                bind(InetSocketAddress("127.0.0.1", targetPort))
            }.close()
            return true
        } catch (_: Throwable) {
            return false
        }
    }

    private fun newPassword(): String {
        val bytes = ByteArray(PASSWORD_BYTES)
        secureRandom.nextBytes(bytes)
        // URL 安全 base64、无填充：43 位，只含取值文法允许的字符。
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }

    companion object {
        /** 默认端口与 AndCode 一致，方便将来对接远端发现与文档互通。 */
        const val DEFAULT_PORT = 4097
        const val SERVER_PASSWORD_ENV = "OPENCODE_SERVER_PASSWORD"
        private const val PASSWORD_BYTES = 32
        private const val START_TIMEOUT_MILLIS = 60_000L
        private const val PROBE_INTERVAL_MILLIS = 200L
        private const val PROBE_TIMEOUT_MILLIS = 1_500
        private const val RELAY_TIMEOUT_MILLIS = 15_000
        private const val MAX_CHAT_TEXT_CHARS = 32_000
        private const val MAX_CHAT_PARTS = 8
        private const val MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
        private const val MAX_STAGE_ATTEMPTS = 100
        private val SESSION_ID_PATTERN = Regex("^[A-Za-z0-9_-]{1,64}$")
        /** 模型标识段字符集（`provider` / `model` 各一段）。 */
        private val MODEL_ID_SEGMENT = Regex("^[A-Za-z0-9_.-]{1,64}$")
        private val MODEL_ID_ALNUM = Regex("[A-Za-z0-9]")
        /** effort 档位名：TUI 侧如 `default`，只收紧字符集。 */
        private val VARIANT_PATTERN = Regex("^[A-Za-z0-9_.-]{1,64}$")
        private val ATTACHMENT_NAME_PATTERN = Regex("^[A-Za-z0-9._-]{1,64}$")
        /** v1 附件类型：图片 + PDF + 纯文本。压缩包/可执行文件不接受。 */
        private val ATTACHMENT_MIME_TYPES = setOf(
            "image/png",
            "image/jpeg",
            "image/gif",
            "image/webp",
            "application/pdf",
            "text/plain",
            "text/markdown",
        )
        private val EXTENSION_MIME = mapOf(
            "png" to "image/png",
            "jpg" to "image/jpeg",
            "jpeg" to "image/jpeg",
            "gif" to "image/gif",
            "webp" to "image/webp",
            "pdf" to "application/pdf",
            "txt" to "text/plain",
            "md" to "text/markdown",
            "markdown" to "text/markdown",
        )
        private const val PROCESS_STOP_TIMEOUT_SECONDS = 5L
        private val secureRandom = SecureRandom()
    }
}

/** 对桥接的只读快照：运行位 + 端口 + 地址（未运行时地址为 null，不含密码）。 */
data class AgentEngineState(
    val running: Boolean,
    val port: Int,
    val baseUrl: String?,
)

/** 聊天分段：文本直传正文；文件/图片传落点内的访客路径引用。 */
data class AgentChatPart(
    val type: String,
    val text: String?,
    val mime: String?,
    val url: String?,
)

/** 已落点的附件：访客路径（`/mnt/inbox/attachments/<名>`）。 */
data class StagedAttachment(
    val guestPath: String,
)

/** 附件内容：mime + base64，界面直接画缩略图。 */
data class AttachmentContent(
    val mime: String,
    val dataBase64: String,
)
