````markdown
# Especificación de Compatibilidad de Relio para Agentes de Código (OpenCode, Claude Code, etc.)

## Objetivo

Validar que Relio implemente correctamente la API esperada por agentes de código modernos (OpenCode, Claude Code y clientes compatibles con OpenAI), garantizando compatibilidad funcional, streaming eficiente y baja latencia.

---

# 1. Compatibilidad con Chat Completions

## Endpoint

```
POST /v1/chat/completions
```

Debe aceptar solicitudes compatibles con la especificación OpenAI.

### Parámetros mínimos soportados

| Parámetro | Requerido | Observaciones |
|-----------|-----------|---------------|
| model | ✅ | Nombre del modelo |
| messages | ✅ | Historial completo |
| stream | ✅ | Debe soportar `true` y `false` |
| temperature | ✅ | Opcional |
| max_tokens | ✅ | Opcional |
| tools | ✅ | Debe aceptar lista de herramientas |
| tool_choice | ✅ | `auto`, `none`, `required` |
| top_p | Opcional | Si el backend lo soporta |
| stop | Opcional | Debe reenviarse correctamente |

---

# 2. Streaming (Server Sent Events)

## Requisito

Cuando:

```json
{
    "stream": true
}
```

Relio **NO** debe esperar a construir la respuesta completa.

Debe retransmitir los chunks conforme los genera el proveedor.

### Formato esperado

```
data: {
  ...
}

data: {
  ...
}

data: [DONE]
```

## Validaciones

- [ ] Los chunks llegan progresivamente.
- [ ] No se acumula la respuesta completa.
- [ ] Se conserva el orden de los eventos.
- [ ] Finaliza con `[DONE]`.

---

# 3. Tiempo al Primer Token (TTFT)

Uno de los parámetros más importantes para agentes.

## Objetivo

| Tiempo | Estado |
|---------|--------|
| < 1 s | Excelente |
| 1–3 s | Muy bueno |
| 3–5 s | Aceptable |
| 5–10 s | Riesgo de timeouts |
| >10 s | Problemático |
| >30 s | Muy probable que algunos clientes abandonen la petición |

Relio no debe introducir latencia adicional significativa.

---

# 4. Tool Calling

Debe aceptar correctamente:

```json
{
    "tools": [
        {
            "type": "function",
            "function": {
                "name": "...",
                "description": "...",
                "parameters": { }
            }
        }
    ]
}
```

Debe soportar:

```
tool_choice = auto
tool_choice = required
tool_choice = none
```

## Respuesta esperada

```json
{
    "tool_calls": [
        {
            "id": "...",
            "type": "function",
            "function": {
                "name": "...",
                "arguments": "{...}"
            }
        }
    ]
}
```

---

# 5. Mensajes

Debe aceptar cualquier secuencia válida de mensajes.

Roles soportados:

- system
- user
- assistant
- tool

Debe conservar:

- orden
- contenido
- metadata

---

# 6. Tool Results

Cuando el cliente responde con el resultado de una herramienta, Relio debe reenviar correctamente:

```json
{
    "role": "tool",
    "tool_call_id": "...",
    "content": "..."
}
```

Sin modificar IDs.

---

# 7. Finish Reason

Debe devolver valores compatibles con OpenAI.

Valores esperados:

```
stop
length
tool_calls
content_filter
```

No debe inventar nuevos valores.

---

# 8. Contexto

Debe reenviar íntegramente el historial recibido.

No debe:

- truncar mensajes
- eliminar mensajes system
- eliminar tools
- modificar prompts

---

# 9. Parámetros del Modelo

Debe reenviar correctamente:

- temperature
- top_p
- top_k
- max_tokens
- stop
- seed (si aplica)

Los parámetros no soportados por el backend deberían ignorarse de forma segura o mapearse adecuadamente, evitando errores innecesarios.

---

# 10. Compatibilidad con Ollama

Debe traducir correctamente entre la API OpenAI y Ollama.

Debe verificar:

- generación normal
- chat
- streaming
- tool calling
- reasoning (si el modelo lo soporta)

---

# 11. Errores

Los errores deben seguir el formato OpenAI.

Ejemplo:

```json
{
    "error": {
        "message": "...",
        "type": "...",
        "code": "..."
    }
}
```

No deben devolverse errores HTML.

---

# 12. Cancelación

Si el cliente cierra la conexión:

- cancelar la generación aguas abajo
- liberar recursos
- cerrar streams

---

# 13. Timeout

Relio no debe imponer un timeout menor al del proveedor.

Idealmente:

- timeout configurable
- sin timeout artificial durante streaming

---

# 14. Headers

Debe conservar:

```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

Cuando corresponda.

---

# 15. Compatibilidad esperada con Agentes

Relio debería ser transparente para:

- OpenCode
- Claude Code
- Continue
- Cline
- Roo Code
- OpenHands
- Aider
- Cursor (OpenAI Compatible)

El cliente no debería poder distinguir si está hablando directamente con OpenAI, Ollama o un proveedor remoto.

---

# 16. Casos de Prueba Recomendados

## Chat simple

- [ ] Respuesta sin streaming.
- [ ] Respuesta con streaming.

---

## Contexto largo

Enviar:

- system grande
- múltiples mensajes
- historial largo

Verificar que no haya truncamiento.

---

## Tool Calling

1. Cliente envía tools.
2. Modelo solicita una tool.
3. Cliente responde con tool result.
4. Modelo continúa correctamente.

---

## Streaming

Validar:

- primer token rápido
- múltiples chunks
- evento `[DONE]`

---

## Cancelación

Cancelar la petición durante la generación y verificar que:

- Ollama deje de generar.
- No queden procesos huérfanos.

---

## Errores

Forzar:

- modelo inexistente
- JSON inválido
- herramienta inválida

Verificar que el formato de error sea compatible con OpenAI.

---

# Criterios de Aceptación

Relio se considera compatible con agentes de código cuando:

- ✅ Implementa completamente `/v1/chat/completions`.
- ✅ Soporta streaming SSE real.
- ✅ Mantiene un TTFT bajo.
- ✅ Soporta Tool Calling.
- ✅ Conserva el contexto íntegro.
- ✅ No modifica mensajes ni prompts.
- ✅ Maneja correctamente `finish_reason`.
- ✅ Traduce correctamente hacia Ollama.
- ✅ Maneja cancelaciones.
- ✅ Devuelve errores compatibles con OpenAI.
- ✅ Funciona sin modificaciones específicas para clientes como OpenCode o Claude Code.
````
