package com.octacode.agent.runtime

class RuntimeFailure(
    val code: String,
    message: String,
    cause: Throwable? = null,
) : Exception(message, cause)
