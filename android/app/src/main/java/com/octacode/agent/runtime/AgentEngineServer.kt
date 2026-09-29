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
    /** 事件流：监听器、泵线程与当前连接；停服时一并收掉。 */
    private var eventListener: ((String) -> Unit)? = null
    private var eventThread: Thread? = null
    private var eventConnection: HttpURLConnection? = null

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
     * 事件流订阅：`GET /event`（SSE）常驻一根后台线程，逐块转成
     * `{"type","data"}` 紧凑 JSON 交给 listener（插件侧再转成 Capacitor 事件）。
     *
     * 思考过程、工具调用、审批请求都走这条总线——轮询看不到“正在发生”，
     * 流能。断线 3 秒重连；服务停了线程自己退出。重复订阅是幂等的
     * （先停旧线程再起新的，不会分叉）。
     */
    fun startEventStream(listener: (String) -> Unit) {
        synchronized(lock) {
            stopEventStreamLocked()
            val current = process
            val password = serverPassword
            if (current?.isAlive != true || password == null || !isReachable(port)) {
                throw RuntimeFailure("AGENT_ENGINE_STOPPED", "Agent 服务未运行，请先启动")
            }
            eventListener = listener
            val thread = Thread({ eventLoop(password) }, "agent-engine-events")
            thread.isDaemon = true
            eventThread = thread
            thread.start()
        }
    }

    fun stopEventStream() {
        synchronized(lock) {
            stopEventStreamLocked()
        }
    }

    private fun stopEventStreamLocked() {
        eventListener = null
        eventThread?.interrupt()
        try {
            eventConnection?.disconnect()
        } catch (_: Throwable) {
            // 断开一个已经半死的连接：本来就是清理动作。
        }
        eventConnection = null
        eventThread = null
    }

    private fun eventLoop(password: String) {
        while (!Thread.currentThread().isInterrupted) {
            var connection: HttpURLConnection? = null
            try {
                synchronized(lock) {
                    if (eventListener == null || process?.isAlive != true) return
                }
                connection = URL("http://127.0.0.1:$port/event").openConnection() as HttpURLConnection
                connection.connectTimeout = PROBE_TIMEOUT_MILLIS
                connection.readTimeout = 0
                connection.instanceFollowRedirects = false
                connection.setRequestProperty("Accept", "text/event-stream")
                val basic = Base64.getEncoder().encodeToString("opencode:$password".toByteArray(Charsets.UTF_8))
                connection.setRequestProperty("Authorization", "Basic $basic")
                synchronized(lock) {
                    if (eventListener == null) {
                        connection.disconnect()
                        return
                    }
                    eventConnection = connection
                }
                if (connection.responseCode !in 200..299) {
                    throw RuntimeException("event stream HTTP ${connection.responseCode}")
                }
                pumpEvents(connection)
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
                return
            } catch (_: Throwable) {
                // 断线/服务抖动：3 秒后重连；调用方 stop 会中断睡眠。
            } finally {
                try {
                    connection?.disconnect()
                } catch (_: Throwable) {
                }
                synchronized(lock) {
                    if (eventConnection === connection) eventConnection = null
                }
            }
            try {
                Thread.sleep(EVENT_RECONNECT_MILLIS)
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
                return
            }
        }
    }

    /** 逐行拼块：空行分块，`event:` 取名（缺省 message），`data:` 可多行。 */
    private fun pumpEvents(connection: HttpURLConnection) {
        val reader = connection.inputStream.bufferedReader(Charsets.UTF_8)
        var type = "message"
        val data = StringBuilder()
        var hasData = false
        while (!Thread.currentThread().isInterrupted) {
            val line = try {
                reader.readLine()
            } catch (_: Throwable) {
                return
            } ?: return
            if (line.isEmpty()) {
                if (hasData) {
                    emitEvent(type, data.toString())
                    type = "message"
                    data.clear()
                    hasData = false
                }
                continue
            }
            if (line.startsWith(":")) continue
            if (line.startsWith("event:")) {
                val name = line.removePrefix("event:").trim()
                if (name.isNotEmpty()) type = name
            } else if (line.startsWith("data:")) {
                if (hasData) data.append('\n')
                data.append(line.removePrefix("data:").removePrefix(" "))
                hasData = true
            }
        }
    }

    private fun emitEvent(type: String, raw: String) {
        val listener = synchronized(lock) { eventListener } ?: return
        val trimmed = raw.trim()
        // 服务端 data 本来就是 JSON：原样嵌入避免二次转义；纯文本才加引号。
        val data = if (trimmed.startsWith("{") || trimmed.startsWith("[")) trimmed else jsonQuote(raw)
        try {
            listener("{\"type\":" + jsonQuote(type) + ",\"data\":" + data + "}")
        } catch (_: Throwable) {
            // 监听方异常不能掐断整条流。
        }
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

    /**
     * 会话改名：`PATCH /session/{id} {title}`（SDK 确认的 body 键）。
     * 标题 1–120 字符，与建会话同一套限制。
     */
    fun sessionRename(sessionId: String, title: String): String = synchronized(lock) {
        if (title.isEmpty() || title.length > 120) {
            throw RuntimeFailure("SETTINGS_INVALID", "会话标题无效")
        }
        return relay("PATCH", "/session/" + requireSessionId(sessionId), "{\"title\":" + jsonQuote(title) + "}")
    }

    /**
     * 会话删除：`DELETE /session/{id}/remove`，成功返回布尔。
     * 注意方法名是 remove 而不是 delete（SDK 路由确认），写错会 404。
     */
    fun sessionDelete(sessionId: String): String = synchronized(lock) {
        return relay("DELETE", "/session/" + requireSessionId(sessionId) + "/remove", null)
    }

    /**
     * 单条消息删除：`DELETE /session/{sid}/message/{mid}`（SDK 路由确认）。
     *
     * 只删消息及其分段，不回滚文件改动——这正是“重新生成/编辑重发”的语义：
     * 先删掉目标及之后的消息，再把（改过的）用户原文当新一轮发出去。
     */
    fun messageDelete(sessionId: String, messageId: String): String = synchronized(lock) {
        if (!ID_PATTERN.matches(messageId)) {
            throw RuntimeFailure("SETTINGS_INVALID", "消息标识无效")
        }
        return relay(
            "DELETE",
            "/session/" + requireSessionId(sessionId) + "/message/" + messageId,
            null,
        )
    }

    /**
     * 中止本轮运行：`POST /session/{id}/abort`，无请求体，成功返回布尔。
     *
     * 界面在发送中/跟随中把发送键换成停止键，点下即调这里并停掉轮询——
     * 这正是旗舰边框“真结束才灭”的另一半：中断是明确的结束。
     */
    fun chatAbort(sessionId: String): String = synchronized(lock) {
        return relay("POST", "/session/" + requireSessionId(sessionId) + "/abort", null)
    }

    /**
     * 从某条消息分叉新会话：`POST /session/{id}/fork {messageID}`。
     *
     * 界面用它实现“重新生成”语义：找到最后一条用户消息，从那里另起一局，
     * 原会话原样保留。messageID 形态与会话标识同族，另行收紧长度。
     */
    fun chatFork(sessionId: String, messageId: String): String = synchronized(lock) {
        if (!ID_PATTERN.matches(messageId)) {
            throw RuntimeFailure("SETTINGS_INVALID", "消息标识无效")
        }
        return relay("POST", "/session/" + requireSessionId(sessionId) + "/fork", "{\"messageID\":" + jsonQuote(messageId) + "}")
    }

    /**
     * 权限审批：`POST /api/session/:sid/permission/:rid/reply {reply, message?}`。
     *
     * reply 只认 `once` / `always` / `reject`（服务端 PermissionV2.Reply 枚举），
     * message 可选说明。成功 204 无内容——relay 把空包转成 `null` 交给界面。
     */
    fun permissionReply(sessionId: String, requestId: String, reply: String, message: String?): String =
        synchronized(lock) {
            if (reply != "once" && reply != "always" && reply != "reject") {
                throw RuntimeFailure("SETTINGS_INVALID", "审批动作无效")
            }
            val body = buildString {
                append("{\"reply\":")
                append(jsonQuote(reply))
                if (!message.isNullOrEmpty()) {
                    if (message.length > MAX_CHAT_TEXT_CHARS) {
                        throw RuntimeFailure("SETTINGS_INVALID", "审批说明过长")
                    }
                    append(",\"message\":")
                    append(jsonQuote(message))
                }
                append('}')
            }
            return relay(
                "POST",
                "/api/session/" + requireSessionId(sessionId) + "/permission/" + requireRequestId(requestId) + "/reply",
                body,
            )
        }

    /**
     * 问答审批：`POST .../question/:rid/reply {answers: [...]}`，
     * 拒绝走 `POST .../reject`（无请求体）。
     *
     * answers 是选中的选项标签数组（服务端按 label 匹配），1–8 个。
     */
    fun questionReply(sessionId: String, requestId: String, answers: List<String>): String =
        synchronized(lock) {
            if (answers.isEmpty() || answers.size > MAX_ANSWERS) {
                throw RuntimeFailure("SETTINGS_INVALID", "问答选项无效")
            }
            val body = buildString {
                append("{\"answers\":[")
                answers.forEachIndexed { index, answer ->
                    if (answer.isEmpty() || answer.length > MAX_ANSWER_CHARS) {
                        throw RuntimeFailure("SETTINGS_INVALID", "问答选项无效")
                    }
                    if (index > 0) append(',')
                    append(jsonQuote(answer))
                }
                append("]}")
            }
            return relay(
                "POST",
                "/api/session/" + requireSessionId(sessionId) + "/question/" + requireRequestId(requestId) + "/reply",
                body,
            )
        }

    fun questionReject(sessionId: String, requestId: String): String = synchronized(lock) {
        return relay(
            "POST",
            "/api/session/" + requireSessionId(sessionId) + "/question/" + requireRequestId(requestId) + "/reject",
            null,
        )
    }

    /** 待答问题：`GET /api/session/:sid/question` 原文透传，解析在前端做。 */
    fun questionList(sessionId: String): String = synchronized(lock) {
        return relay("GET", "/api/session/" + requireSessionId(sessionId) + "/question", null)
    }

    /**
     * 待批权限全局 feed：`GET /api/permission/request` 原文透传，
     * 前端按 sessionID 过滤出本会话的。没有按会话查的端点，这是唯一的待批来源。
     */
    fun permissionFeed(): String = synchronized(lock) {
        return relay("GET", "/api/permission/request", null)
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
        // 自动选端口：明确指定的只认那一个；缺省从 4097 起顺延找空位。
        // 背景：真机上 4097 可能被上一次运行的孤儿进程占着（应用被杀时
        // 来不及收尸），也可能被其它应用占着——无论哪种，换个端口服务
        // 照常跑（中继不直连端口），总比一个修不好的报错强。
        // 显式指定的端口仍保持严格失败：那是用户明确要的绑定。
        val candidates = if (requestedPort != null) {
            if (requestedPort !in 1024..65535) {
                throw RuntimeFailure("SETTINGS_INVALID", "Agent 服务端口超出范围")
            }
            listOf(requestedPort)
        } else {
            (DEFAULT_PORT..LAST_FALLBACK_PORT).toList()
        }
        val targetPort = candidates.firstOrNull { isPortFree(it) }
            ?: throw RuntimeFailure(
                "AGENT_ENGINE_PORT_BUSY",
                "Agent 服务端口都被占用（${candidates.first} 起连续 ${candidates.size} 个）：请关闭占用端口的应用后重试",
            )
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

    private fun requireRequestId(requestId: String): String {
        if (!ID_PATTERN.matches(requestId)) {
            throw RuntimeFailure("SETTINGS_INVALID", "请求标识无效")
        }
        return requestId
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
        stopEventStreamLocked()
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
        /** 自动选端口的上界：4097 起连续 8 个，体面够用又不至于扫半个端口表。 */
        const val LAST_FALLBACK_PORT = 4104
        const val SERVER_PASSWORD_ENV = "OPENCODE_SERVER_PASSWORD"
        private const val PASSWORD_BYTES = 32
        private const val START_TIMEOUT_MILLIS = 60_000L
        private const val PROBE_INTERVAL_MILLIS = 200L
        private const val PROBE_TIMEOUT_MILLIS = 1_500
        private const val EVENT_RECONNECT_MILLIS = 3_000L
        private const val RELAY_TIMEOUT_MILLIS = 15_000
        private const val MAX_CHAT_TEXT_CHARS = 32_000
        private const val MAX_CHAT_PARTS = 8
        private const val MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
        private const val MAX_STAGE_ATTEMPTS = 100
        private val SESSION_ID_PATTERN = Regex("^[A-Za-z0-9_-]{1,64}$")
        /** 消息/请求标识：与会话标识同族字符集，放宽长度（服务端形如 msg_…）。 */
        private val ID_PATTERN = Regex("^[A-Za-z0-9_.-]{1,128}$")
        private const val MAX_ANSWERS = 8
        private const val MAX_ANSWER_CHARS = 200
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
