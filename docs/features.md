# Routing Strategies

Las **Routing Strategies** definen cómo el proxy selecciona el proveedor LLM para cada solicitud. En lugar de usar un proveedor fijo, el proxy evalúa métricas (costo, presupuesto, latencia, salud y calidad) y aplica una política de enrutamiento.

## Estrategias

### Cheapest
Prioriza el proveedor con menor costo disponible. Ideal para minimizar gastos.

### Performance
Prioriza el modelo de mayor calidad, ignorando el costo hasta alcanzar los límites configurados.

### Balanced
Distribuye las solicitudes entre varios proveedores para equilibrar consumo, costo y disponibilidad.

### Budget
Controla el consumo en función del presupuesto diario, semanal o mensual. Si un proveedor supera el consumo esperado, cambia automáticamente al siguiente para evitar agotar la cuota.

### Latency
Selecciona el proveedor con menor latencia promedio para obtener la respuesta más rápida.

### High Availability
Prioriza proveedores saludables. Si uno falla, presenta errores o supera el tiempo de espera, cambia automáticamente al siguiente.

### Sticky
Mantiene todas las solicitudes de una misma conversación en el mismo proveedor para preservar consistencia en el contexto y el estilo de respuesta.

### Smart
Calcula una puntuación para cada proveedor combinando múltiples factores (calidad, costo, latencia y presupuesto) y selecciona el que obtenga el mejor resultado.

---

## Factores de decisión

Cada proveedor mantiene métricas como:

- Estado de salud (Healthy/Unhealthy)
- Latencia promedio
- Presupuesto restante
- Tokens consumidos
- Costo acumulado
- Prioridad
- Calidad del modelo (Score configurable)

Estas métricas permiten que el proxy tome decisiones dinámicas y cambie automáticamente de proveedor cuando sea necesario.

# Routing Strategies

Las **Routing Strategies** definen cómo el proxy selecciona el proveedor LLM para cada solicitud. En lugar de usar un proveedor fijo, el proxy evalúa métricas (costo, presupuesto, latencia, salud y calidad) y aplica una política de enrutamiento.

## Flujo de evaluación

Para cada solicitud, el proxy sigue el siguiente proceso:

1. Obtiene la lista de proveedores compatibles con el modelo solicitado.
2. Descarta proveedores no disponibles o con errores.
3. Evalúa la estrategia configurada.
4. Selecciona el proveedor con mayor prioridad según la estrategia.
5. Si la solicitud falla, intenta automáticamente con el siguiente proveedor (Fallback).
6. Registra métricas de uso para futuras decisiones.

---

## Estrategias

### Cheapest
Prioriza el proveedor con menor costo disponible. Ideal para minimizar gastos.

### Performance
Prioriza el modelo de mayor calidad, ignorando el costo hasta alcanzar los límites configurados.

### Balanced
Distribuye las solicitudes entre varios proveedores para equilibrar consumo, costo y disponibilidad.

### Budget
Controla el consumo en función del presupuesto diario, semanal o mensual. Si un proveedor supera el consumo esperado, cambia automáticamente al siguiente para evitar agotar la cuota.

### Latency
Selecciona el proveedor con menor latencia promedio para obtener la respuesta más rápida.

### High Availability
Prioriza proveedores saludables. Si uno falla, presenta errores o supera el tiempo de espera, cambia automáticamente al siguiente.

### Sticky
Mantiene todas las solicitudes de una misma conversación en el mismo proveedor para preservar consistencia en el contexto y el estilo de respuesta.

### Smart
Calcula una puntuación para cada proveedor combinando múltiples factores (calidad, costo, latencia y presupuesto) y selecciona el que obtenga el mejor resultado.

---

## Factores de decisión

Cada proveedor mantiene métricas como:

- Estado de salud (Healthy/Unhealthy)
- Latencia promedio
- Presupuesto restante
- Tokens consumidos
- Costo acumulado
- Prioridad
- Calidad del modelo (Score configurable)
- Número de errores recientes
- Tiempo desde el último fallo

Estas métricas permiten que el proxy tome decisiones dinámicas y cambie automáticamente de proveedor cuando sea necesario.

---

## Fallback

Si el proveedor seleccionado no puede procesar la solicitud (timeout, error, rate limit o presupuesto agotado), el proxy intenta automáticamente con el siguiente proveedor elegible según la estrategia configurada.

---

## Extensibilidad

Cada estrategia debe implementarse como un componente independiente que reciba el estado actual de los proveedores y devuelva el proveedor seleccionado. Esto permite agregar nuevas estrategias sin modificar el núcleo del sistema.

Ejemplos de futuras estrategias:

- Round Robin
- Weighted Round Robin
- Region Aware
- Cost Cap
- SLA Based
- Custom Rules