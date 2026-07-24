# Traspaso técnico: Gemini Notebook MCP

Fecha: 2026-07-24  
Workspace: `D:\Proyectos Personales\notebooklm-mcp`

## Objetivo

Corregir el flujo completo del MCP para que:

1. La autenticación interactiva se cierre y persista correctamente.
2. `ask_question` nunca devuelva una respuesta anterior ni el razonamiento
   interno temporal de Gemini.
3. La respuesta se asocie con la pregunta exacta que originó el turno.
4. El formato de listas, párrafos y citas sea legible en Markdown.
5. `reset_session` borre realmente el historial y no se limite a recargar.
6. Existan pruebas automáticas y una prueba real de dos turnos consecutivos.

## Estado actual del repositorio

- Rama actual: `main`
- HEAD actual: `1efdd4b`
- Origin actual:
  `https://github.com/CharlieCardenasToledo/gemini-notebook-mcp.git`
- El servidor de prueba local quedó detenido de forma intencional.
- La autenticación de Google se renovó correctamente durante esta sesión.
- No ejecutar `git reset --hard`, `git checkout -- .` ni una limpieza global:
  hay trabajo local todavía no comprometido.
- En Windows, `git status` muestra muchos archivos como modificados por
  diferencias CRLF/LF. `git diff --name-only` confirma que los cambios reales
  pendientes son un subconjunto mucho menor.

### Historial ya comprometido

```text
1efdd4b Rename project to Gemini Notebook MCP and point at the new independent repo
e6d3c7c Merge fix/notebooklm-auth-http-reliability into main
5df4573 Add configurable data dir, chat improvements, and chat tests
d3c239b Add live-chat inspector script and ignore local RTFM index
371a6e1 Improve-auth-HTTP-safety-and-session-reliability
```

Durante el trabajo, otra automatización o proceso cambió el checkout a `main`,
fusionó la rama de correcciones y renombró el proyecto. Ese estado se preservó.

## Cambios locales pendientes reales

Obtener la lista exacta con:

```powershell
git diff --name-only
git ls-files --others --exclude-standard
```

En el último control, los cambios reales eran:

- `package.json`
  - Añade `npm run mcp:test-live`.
- `scripts/inspect-live-chat.mjs`
  - Inspector Playwright/Patchright del DOM actual.
  - Detecta automáticamente el directorio de datos normal o el virtualizado de
    Claude Desktop.
  - Soporta `--probe`, `--menu`, `--html` y perfil persistente mediante
    `NOTEBOOKLM_PROFILE_DIR`.
  - Muestra diagnóstico seguro de URL/título cuando no aparece el chat.
- `scripts/test-live-chat.mjs`
  - Nueva prueba real de extremo a extremo con dos preguntas en el mismo
    `session_id`.
  - Exige que la primera respuesta contenga `PRIMERA`, la segunda `SEGUNDA` y
    que la segunda no reutilice `PRIMERA`.
- `src/notebooklm/chat.ts`
  - Correlación tolerante entre pregunta enviada y mensaje renderizado.
  - Selección y extracción atómicas dentro de un único `evaluateAll`.
  - Espera la señal real de finalización.
  - Detección secundaria de razonamiento extendido tomada conceptualmente del
    PR upstream #75.
  - El filtro de respuestas anteriores se aplica sólo al fallback no
    correlacionado.
  - Conserva listas y citas con formato Markdown.
  - Añade logs de transición sin imprimir el contenido de la respuesta.
- `src/session/browser-session.ts`
  - Comprueba redirección real a `accounts.google.com`, no sólo expiración de
    cookies.
  - Desactiva errores tipográficos deliberados durante la escritura.
  - Envía Enter sobre el textarea correcto y conserva fallback al botón.
- `tests/chat.test.ts`
  - Regresiones de respuesta vieja, razonamiento incompleto, preguntas
    repetidas, normalización, formato y heurística del PR #75.
- `HANDOFF_GEMINI_NOTEBOOK_MCP.md`
  - Este documento.

## Diagnóstico comprobado con Playwright/Patchright

### 1. El historial se hidrata después del textarea

`textarea.query-box-input` puede estar visible mientras todavía existen cero
`chat-message` o cero respuestas montadas. Después de desplazarse al final,
Angular monta el historial anterior.

Consecuencia anterior: se tomaba una captura vacía; al aparecer el historial,
una respuesta vieja parecía una respuesta nueva.

Corrección: `settleChatHistory()` pulsa `button.jump-to-bottom-button`, desplaza
el último mensaje y espera una firma estable antes del envío.

### 2. Gemini escribe razonamiento interno en el mismo nodo de respuesta

Durante la generación, `.message-text-content` contiene secuencias como:

```text
Analyzing your files...
Sifting through pages...
Opening your notes...
Interpreting the Prompt
I'm zeroing in on...
```

Señales reales observadas:

- Generando:
  - `button.stop-button`
  - `aria-label="Dejar de generar"`
  - `.thinking-animation-container`
  - No existe `.message-actions`.
- Finalizada:
  - Desaparece `button.stop-button`.
  - Aparece `.message-actions`.
  - El texto temporal se reemplaza por la respuesta final.

La estabilidad del texto por sí sola no es una señal de finalización.

### 3. Había una carrera entre seleccionar y leer el nodo

La primera implementación:

1. Localizaba el índice del mensaje correcto con `evaluateAll`.
2. En una segunda operación hacía `locator(...).nth(index).innerText()`.

Angular podía rehidratar o reordenar nodos entre ambas operaciones. Se
reprodujo de forma real:

- El DOM final contenía `PRIMERA`.
- El MCP devolvió una lista anterior de fuentes.

Corrección: localizar el turno, verificar `.message-actions`, clonar el nodo,
formatearlo y extraer el texto dentro del mismo `evaluateAll`. La operación es
atómica respecto al hilo principal del navegador.

### 4. El filtro global descartaba respuestas válidas repetidas

Después de corregir la correlación, una prueba que volvía a producir
`PRIMERA` quedaba esperando porque `ignoreTexts` ya contenía ese texto.

Corrección: `ignoreTexts` sólo se usa cuando no hay una pregunta correlacionada.
Una respuesta ligada al turno exacto puede repetir legítimamente un texto
anterior.

### 5. El reset anterior no borraba el historial

Recargar la página mantiene la conversación porque el historial está en el
servidor de NotebookLM.

El menú real observado es:

```text
Opciones de chat
└── Borrar el historial de chat
```

La implementación ya comprometida usa ese menú, maneja un posible diálogo de
confirmación y verifica que desaparezcan los contenedores de respuesta.

No se ejecutó una prueba destructiva de `reset_session` sobre el historial del
usuario.

### 6. Cookies con fecha válida no equivalen a sesión válida

Google redirigió a:

```text
https://accounts.google.com/.../accountchooser
```

aunque las cookies tenían fecha de expiración futura. El servidor informaba
falsamente “Session already authenticated” y luego fallaba con “chat input not
found”.

Corrección local: además de validar expiración, se comprueba si la página actual
es `accounts.google.com` o una ruta `/login`. En ese caso se exige reautenticación.

## Revisión del PR upstream #75

PR:
<https://github.com/PleasePrompto/notebooklm-mcp/pull/75>

Conclusión:

- Sí soluciona una parte: identifica por forma textual los resúmenes de
  razonamiento extendido (`Refining the Focus`, `I'm...`, `My next task...`).
- No correlaciona una respuesta con la pregunta que originó el turno.
- No resuelve hidratación del historial.
- No usa las señales `stop-button` y `.message-actions`.
- No resuelve la carrera selección/lectura.
- No corrige `reset_session`.
- No corrige la falsa autenticación basada sólo en expiración.

Se integró su heurística como defensa secundaria y se adaptaron sus casos de
prueba. La señal primaria sigue siendo el estado real del DOM.

## Formato de respuesta

La estructura observada usa:

```html
<labs-tailwind-doc-viewer>
  <element-list-renderer>
    <ul>
      <li class="paragraph list-item">...</li>
    </ul>
  </element-list-renderer>
</labs-tailwind-doc-viewer>
```

`innerText` conserva saltos de línea, pero no incluye viñetas. La extracción
actual:

- Añade `- ` a listas no ordenadas.
- Añade `1.`, `2.`, etc. a listas ordenadas.
- Convierte marcadores numéricos de cita a `[n]`.
- Elimina controles Material filtrados.
- Conserva una línea en blanco entre párrafos.

## Pruebas ejecutadas

### Suite automática

Comando:

```powershell
npm run check
```

Último resultado:

```text
format: OK
lint: OK
build: OK
tests: 14 passed, 0 failed
```

### Prueba real de dos turnos

Comando:

```powershell
npm run mcp:test-live
```

Resultado final:

```json
{
  "success": true,
  "session_id": "2bc979cc",
  "first_answer": "...\\n\\nPRIMERA.",
  "second_answer": "...\\n\\nSEGUNDA."
}
```

Ambas preguntas reutilizaron el mismo `session_id`. Esto confirma:

- No se devolvió una respuesta histórica.
- No se devolvió el razonamiento interno.
- No se reutilizó `PRIMERA` en el segundo turno.
- Se esperó hasta que cada respuesta estuviera finalizada.

## Comandos útiles

### Compilar y validar

```powershell
npm run check
```

### Iniciar HTTP con el estado autenticado usado en esta máquina

En `cmd.exe`:

```bat
set NOTEBOOKLM_DATA_DIR=C:\Users\charlieact7\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\notebooklm-mcp\Data&& node .\dist\index.js --transport http --host 127.0.0.1 --port 3000
```

### Renovar autenticación

Con el servidor HTTP ya activo:

```powershell
npm run mcp:auth
```

El navegador debe cerrarse automáticamente al llegar a NotebookLM.

### Inspeccionar DOM sin enviar una pregunta

```powershell
npm run mcp:inspect
```

### Inspeccionar menú

```powershell
npm run mcp:inspect -- --menu
```

### Enviar una consulta de diagnóstico y capturar transiciones

```powershell
npm run mcp:inspect -- --probe
```

### Ejecutar la prueba real de dos turnos

Con el servidor HTTP activo:

```powershell
npm run mcp:test-live
```

## Los cuatro pasos restantes del plan original

Estos eran los cuatro pasos que quedaban pendientes después de diagnosticar y
corregir inicialmente la correlación de respuestas. Deben conservarse como
parte explícita del traspaso, aunque durante esta sesión se avanzó en los tres
primeros.

### 1. Implementar un reinicio real del chat

Estado: **implementado, pendiente de prueba destructiva explícita**.

- Sustituir la recarga de página por:
  `Opciones de chat` → `Borrar el historial de chat`.
- Manejar el posible diálogo de confirmación.
- Verificar que desaparezcan los contenedores de respuestas.
- Mantener el mismo `session_id` y reiniciar `message_count`.
- Probar `reset_session` solamente con autorización del usuario, porque borra
  el historial real del notebook.
- Después del reset, enviar una pregunta nueva y confirmar que ninguna
  respuesta anterior puede reaparecer.

### 2. Agregar pruebas de regresión y utilidades de inspección

Estado: **implementado localmente, pendiente de revisión final y commit**.

- Mantener las pruebas de:
  - respuesta anterior frente a una pregunta nueva;
  - razonamiento extendido de Gemini;
  - preguntas repetidas;
  - respuestas cuyo texto coincide con una respuesta anterior;
  - normalización de espacios, comillas y acentos;
  - conservación de párrafos y listas.
- Conservar `scripts/inspect-live-chat.mjs` como herramienta de diagnóstico.
- Conservar `scripts/test-live-chat.mjs` como prueba real de dos turnos.
- Considerar una prueba adicional con DOM simulado que reproduzca una
  rehidratación entre selección y lectura.

### 3. Validar con la suite y consultas reales consecutivas

Estado: **completado; debe repetirse antes de publicar**.

- Ejecutar `npm run check`.
- Iniciar el servidor HTTP con el `NOTEBOOKLM_DATA_DIR` correcto.
- Ejecutar `npm run mcp:test-live`.
- Confirmar en el mismo `session_id`:
  - primera respuesta: `PRIMERA`;
  - segunda respuesta: `SEGUNDA`;
  - la segunda no contiene `PRIMERA`;
  - ningún resultado contiene razonamiento tipo `Refining/Interpreting...`.
- Si se modifica cualquier parte de `chat.ts`, repetir obligatoriamente la
  prueba real.

### 4. Revisar, comprometer y publicar los cambios

Estado: **pendiente**.

- Revisar `git diff` y separar cambios reales de ruido CRLF/LF.
- Stagear únicamente los archivos reales descritos en este documento.
- No usar ramas con prefijo `codex/` ni `agent/`.
- No añadir a Codex ni a otra IA como coautor.
- Crear un commit humano y claro.
- Confirmar con el usuario si se publicará:
  - directamente en
    `CharlieCardenasToledo/gemini-notebook-mcp`, o
  - como actualización/nuevo PR hacia
    `PleasePrompto/notebooklm-mcp`.
- Si el destino es upstream, explicar que el PR #75 sólo aporta la heurística
  textual y que esta solución añade correlación por turno, señales DOM,
  extracción atómica, reset real y autenticación efectiva.
- Ejecutar nuevamente las pruebas después del commit y antes del push.

## Plan para la siguiente IA

1. Leer este documento completo.
2. Ejecutar:

   ```powershell
   git status -sb
   git diff --name-only
   git ls-files --others --exclude-standard
   ```

3. No tocar los archivos que sólo aparecen por CRLF/LF si no tienen diff real.
4. Revisar cuidadosamente el diff real de:
   - `src/notebooklm/chat.ts`
   - `src/session/browser-session.ts`
   - `scripts/inspect-live-chat.mjs`
   - `scripts/test-live-chat.mjs`
   - `tests/chat.test.ts`
   - `package.json`
5. Ejecutar `npm run check`.
6. Opcionalmente repetir `npm run mcp:test-live`; requiere iniciar antes el
   servidor HTTP con `NOTEBOOKLM_DATA_DIR`.
7. No ejecutar `reset_session` contra el notebook real sin autorización
   explícita, porque borra el historial del usuario.
8. Si todo sigue correcto, crear un commit limpio:
   - Sin prefijo de rama `codex/` ni `agent/`.
   - Sin coautor de Codex o de otra IA.
   - Stagear sólo archivos con cambios reales.
9. Antes de publicar, confirmar el destino:
   - El `origin` actual es el repositorio independiente
     `CharlieCardenasToledo/gemini-notebook-mcp`.
   - El PR upstream original de esta línea de trabajo fue
     <https://github.com/PleasePrompto/notebooklm-mcp/pull/77>.
   - El PR upstream #75 sigue abierto y sólo cubre la heurística de
     razonamiento.
10. Actualizar README/changelog si el usuario quiere documentar formalmente:
    - Correlación atómica por turno.
    - Señal de finalización real.
    - `NOTEBOOKLM_DATA_DIR`.
    - `npm run mcp:test-live`.

## Criterios de aceptación

El trabajo se considera terminado cuando:

- `npm run check` pasa.
- La prueba real devuelve `PRIMERA` y luego `SEGUNDA` en el mismo `session_id`.
- Una respuesta que repite texto anterior no queda bloqueada.
- Un bloque `Interpreting/Refining... I'm...` nunca se entrega como final.
- Una redirección a Google Sign-In se reporta como autenticación necesaria.
- Sólo se comprometen archivos con cambios reales.
- El commit no incluye coautor de IA.
