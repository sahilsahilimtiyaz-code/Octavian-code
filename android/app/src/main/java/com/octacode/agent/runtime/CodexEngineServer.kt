package com.octacode.agent.runtime

import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * 本机 Codex 服务：访客里跑官方 `codex app-server`，走 stdio JSON-RPC。
 *
 * 与 OpenCode 的 HTTP 方案不同，这里没有端口、没有密码、没有跨域：
 * 宿主往子进程 stdin 写一行 JSON，stdout 逐行读回。请求带数字 id 配对，
 * 不带 id 的是服务端通知（turn/item/审批/用量），经 listener 交给插件
 * 转成 `codexEvent` 桥事件。
 *
 * 秘密：codex 的登录态（ChatGPT OAuth / API Key）在它自己的家目录里
 * （用户在终端完成 `codex login`），本服务不碰任何凭据，也因此与
 * Harness 可以同时运行——没有共用的环境文件可踩。
 *
 * 帧格式按 MCP 惯例逐行 JSON；启动时先做 `initialize` 握手，进程秒退
 * （比如某版本默认不是 stdio）则换一组 argv 重试一次，日志留档。
 */
class CodexEngineServer(private val store: RuntimeStore) {
    private val lock = Any()
    private var process: Process? = null
    private var writer: BufferedWriter? = null
    private var readerThread: Thread? = null
    private var nextId = AtomicInteger(1)
    private val pending = ConcurrentHashMap<Int, PendingCall>()
    private var eventListener: ((String) -> Unit)? = null

    private data class PendingCall(
        val latch: CountDownLatch = CountDownLatch(1),
        @Volatile var response: String? = null,
    )

    /** 只读快照：进程在位即运行中（stdio 无端口可探）。 */
    fun state(): CodexEngineState = synchronized(lock) {
        val alive = process?.isAlive == true
        if (!alive && process != null) cleanupLocked()
        return CodexEngineState(running = process?.isAlive == true)
    }

    /**
     * 启动服务：按序尝试两种 argv（带/不带 `--listen stdio://`），
     * 第一个完成 `initialize` 握手的胜出，其余就地销毁。
     */
    fun start(): CodexEngineState = synchronized(lock) {
        if (process?.isAlive == true) return state()
        stopLocked()
        // 先收上一次的尸：stdio 服务没有端口可查，孤儿只能靠 pidfile 认。
        EngineResidual.reapPidFile(store.codexEnginePidFile, store.launchRunnerFile.absolutePath)
        // 启动硬链接由 EngineLaunchResolver 在解析时布好，这里只做宿主侧速检。
        if (!File(store.currentRoot, "usr/local/bin/codex").isFile) {
            throw RuntimeFailure("AGENT_ENGINE_MISSING", "运行时未内置 codex，请先安装运行时")
        }
        // 预检同 opencode 侧：起不来时先说清是运行器的问题还是系统拒绝。
        if (!store.launchRunnerFile.isFile) {
            throw RuntimeFailure("RUNNER_UNAVAILABLE", "APK 未包含当前架构的受信任运行器")
        }
        if (!store.launchRunnerFile.canExecute()) {
            throw RuntimeFailure("RUNNER_UNAVAILABLE", "本机运行器不可执行，请重装应用后重试")
        }
        val attempts = listOf(
            listOf("/usr/local/bin/codex", "app-server", "--listen", "stdio://"),
            listOf("/usr/local/bin/codex", "app-server"),
        )
        var lastError: Throwable? = null
        for (argv in attempts) {
            try {
                startAttempt(argv)
                val started = process
                if (started != null) {
                    EngineResidual.ownPid(started)?.let { pid ->
                        EngineResidual.writePidFile(store.codexEnginePidFile, pid)
                    }
                }
                return state()
            } catch (error: Throwable) {
                lastError = error
                stopLocked()
            }
        }
        throw RuntimeFailure(
            "AGENT_ENGINE_START_FAILED",
            "Codex 服务启动失败：" + (lastError?.message ?: "未知错误"),
        )
    }

    private fun startAttempt(guestArgv: List<String>) {
        // 启动档同样走统一解析器（argv 形态由它按探测结果定，这里只给入口）。
        // 注意：argv 如果有两种（带/不带 --listen）就各走一次完整解析，
        // 探中的那一套直接用来起真进程，不浪费第二次探测。
        val spec = EngineLaunchResolver(store.hostContext, store).launchEngine(
            engineId = "codex",
            entrypoint = guestArgv,
            probeEntrypoint = listOf("/usr/local/bin/codex", "--version"),
            cliRelativePath = "usr/local/bin/codex",
            secrets = RuntimeSecretDelivery.NONE,
        )
        val logFile = File(store.harnessPidFile.parentFile, "codex-app-server.log")
        logFile.parentFile?.mkdirs()
        val launched = try {
            ProcessBuilder(spec.argv)
                .directory(store.currentRoot)
                .redirectError(ProcessBuilder.Redirect.appendTo(logFile))
                .also { builder ->
                    builder.environment().clear()
                    builder.environment().putAll(spec.environment)
                }
                .start()
        } catch (error: Throwable) {
            val cause = error.message?.takeIf { it.isNotBlank() } ?: error.javaClass.simpleName
            throw RuntimeFailure("AGENT_ENGINE_START_FAILED", "Codex 服务进程启动失败：$cause")
        }
        val output = launched.inputStream.bufferedReader(Charsets.UTF_8)
        val input = launched.outputStream.bufferedWriter(Charsets.UTF_8)
        // 等待位必须在写之前登记：应答可能在写完瞬间就回来，晚登记就漏配对。
        val handshake = PendingCall()
        pending[0] = handshake
        val thread = Thread({
            try {
                pumpOutput(output)
            } catch (_: Throwable) {
            }
        }, "codex-engine-io")
        thread.isDaemon = true
        process = launched
        writer = input
        readerThread = thread
        thread.start()
        try {
            input.write("{\"method\":\"initialize\",\"params\":{},\"id\":0}\n")
            input.flush()
        } catch (_: Throwable) {
            pending.remove(0)
            throw RuntimeFailure("AGENT_ENGINE_START_FAILED", "Codex 服务握手写入失败")
        }
        try {
            // 最多等 20 秒，但进程秒退不等满：每 500 毫秒看一眼存活。
            val deadline = System.currentTimeMillis() + HANDSHAKE_TIMEOUT_MILLIS
            var answer: String? = null
            while (System.currentTimeMillis() < deadline) {
                if (!launched.isAlive) {
                    throw RuntimeFailure("AGENT_ENGINE_START_FAILED", "Codex 服务秒退（argv 不被该版本接受）。" + logTailNote(logFile))
                }
                if (handshake.latch.await(PROBE_STEP_MILLIS, TimeUnit.MILLISECONDS)) {
                    answer = handshake.response
                    break
                }
            }
            if (answer == null) {
                throw RuntimeFailure("AGENT_ENGINE_START_FAILED", "Codex 服务握手超时。" + logTailNote(logFile))
            }
            if (answer.contains("\"error\"")) {
                throw RuntimeFailure("AGENT_ENGINE_START_FAILED", "Codex 服务握手被拒绝。" + logTailNote(logFile))
            }
        } catch (failure: RuntimeFailure) {
            throw failure
        } catch (_: Throwable) {
            throw RuntimeFailure("AGENT_ENGINE_START_FAILED", "Codex 服务握手失败")
        } finally {
            pending.remove(0)
        }
    }

    /** 停止服务；幂等。 */
    fun stop(): CodexEngineState = synchronized(lock) {
        stopLocked()
        EngineResidual.deletePidFile(store.codexEnginePidFile)
        return state()
    }

    /** 轻量存活（无探针）：只给安装/切换门引用，判定本身仍以握手为准。 */
    fun isAlive(): Boolean = synchronized(lock) { process?.isAlive == true }

    private fun stopLocked() {
        val current = process
        process = null
        eventListener = null
        pending.values.forEach { it.latch.countDown() }
        pending.clear()
        try {
            writer?.close()
        } catch (_: Throwable) {
        }
        writer = null
        readerThread?.interrupt()
        readerThread = null
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
    }

    private fun cleanupLocked() {
        process = null
        eventListener = null
        writer = null
        readerThread = null
        pending.values.forEach { it.latch.countDown() }
        pending.clear()
    }

    /**
     * 通用调用：`{"method","params","id"}` 写一行，等配对应答。
     *
     * 方法名走白名单（防桥滥用去调危险管理方法）；params 必须是 JSON 对象形态，
     * 大小 512KB 封顶。返回应答原文（`result` 或 `error` 由前端解析）。
     */
    fun rpc(method: String, paramsJson: String?): String {
        if (!RPC_METHOD_ALLOWLIST.contains(method)) {
            throw RuntimeFailure("SETTINGS_INVALID", "不支持的调用")
        }
        val body = paramsJson.orEmpty()
        if (body.length > MAX_PARAMS_CHARS) {
            throw RuntimeFailure("SETTINGS_INVALID", "调用参数过大")
        }
        val id: Int
        val call = PendingCall()
        synchronized(lock) {
            val output = writer
            val current = process
            if (output == null || current?.isAlive != true) {
                throw RuntimeFailure("AGENT_ENGINE_STOPPED", "Codex 服务未运行，请先启动")
            }
            id = nextId.getAndIncrement()
            pending[id] = call
            try {
                output.write("{\"method\":" + quoteJson(method) + ",\"params\":" + body.ifEmpty { "{}" } + ",\"id\":" + id + "}\n")
                output.flush()
            } catch (_: Throwable) {
                pending.remove(id)
                throw RuntimeFailure("AGENT_ENGINE_REQUEST_FAILED", "Codex 服务写入失败")
            }
        }
        val arrived = try {
            call.latch.await(RPC_TIMEOUT_MILLIS, TimeUnit.MILLISECONDS)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
            false
        }
        pending.remove(id)
        val response = call.response
        if (!arrived || response == null) {
            throw RuntimeFailure("AGENT_ENGINE_REQUEST_FAILED", "Codex 服务无应答")
        }
        return response
    }

    fun startEventStream(listener: (String) -> Unit) {
        synchronized(lock) {
            if (process?.isAlive != true) {
                throw RuntimeFailure("AGENT_ENGINE_STOPPED", "Codex 服务未运行，请先启动")
            }
            eventListener = listener
        }
    }

    fun stopEventStream() {
        synchronized(lock) {
            eventListener = null
        }
    }

    /**
     * 进程 stderr 尾巴（stdout 被读泵消费了，这里只能拿到 stderr 那一半）。
     * opencode 侧是全量日志，这里是半量——有总比“秒退”两个字强。
     */
    private fun logTailNote(logFile: File): String {
        val tail = try {
            if (!logFile.isFile) return ""
            String(logFile.readBytes().takeLast(LOG_TAIL_BYTES).toByteArray(), Charsets.UTF_8)
                .replace(Regex("[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F]"), " ")
                .trim()
                .takeIf { it.isNotEmpty() }
        } catch (_: Throwable) {
            null
        } ?: return ""
        return " 进程遗言：$tail"
    }

    /** 读泵：带 id 的配对唤醒等待者，不带 id 的按通知交给监听器。 */
    private fun pumpOutput(output: BufferedReader) {
        while (!Thread.currentThread().isInterrupted) {
            val line = try {
                output.readLine()
            } catch (_: Throwable) {
                return
            } ?: return
            if (line.isBlank()) continue
            val id = extractId(line)
            if (id != null) {
                pending[id]?.let {
                    it.response = line
                    it.latch.countDown()
                }
                continue
            }
            val listener = synchronized(lock) { eventListener }
            if (listener != null) {
                try {
                    listener(line)
                } catch (_: Throwable) {
                    // 监听方异常不能掐断整条流。
                }
            }
        }
    }

    /** 配对 id 提取：`{"id": 12, ...}`；字符串 id 查不到等待位就当通知。 */
    private fun extractId(line: String): Int? {
        val match = ID_PATTERN.find(line) ?: return null
        return match.groupValues[1].toIntOrNull()
    }

    private fun quoteJson(value: String): String = buildString {
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

    companion object {
        private const val PROCESS_STOP_TIMEOUT_SECONDS = 5L
        private const val RPC_TIMEOUT_MILLIS = 60_000L
        private const val HANDSHAKE_TIMEOUT_MILLIS = 20_000L
        private const val PROBE_STEP_MILLIS = 500L
        private const val LOG_TAIL_BYTES = 1_500
        private const val MAX_PARAMS_CHARS = 512 * 1024
        private val ID_PATTERN = Regex("\"id\"\\s*:\\s*(\\d+)")
        /**
         * 允许经桥调用的方法：会话/回合/模型/账号只读 + 审批相关。
         * 管理类（config 写、daemon、remote-control）一律不暴露。
         */
        private val RPC_METHOD_ALLOWLIST = setOf(
            "initialize",
            "thread/start",
            "thread/resume",
            "thread/fork",
            "thread/list",
            "thread/read",
            "thread/turns/list",
            "thread/items/list",
            "turn/start",
            "turn/interrupt",
            "turn/steer",
            "model/list",
            "account/read",
            "account/rateLimits/read",
            "config/read",
            "collaborationMode/list",
        )
    }
}

/** Codex 服务只读快照：stdio 无端口可探，进程在位即运行中。 */
data class CodexEngineState(
    val running: Boolean,
)
