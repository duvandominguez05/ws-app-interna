# Plan App Interna W&S Por Roles

## Objetivo

La app interna debe ser el cerebro operativo de W&S. La idea no es que todos vean todo, sino que cada persona entre a una vista simple segun su trabajo, haga acciones claras y que administracion pueda monitorear todo el flujo.

El enfoque principal es:

- Trabajadores: ver solo lo que deben hacer hoy.
- Admin: ver todo, cargas, atrasos, responsables y estados.
- Celular: uso simple, botones grandes, pocas opciones.
- PC: tablero completo, torre de control, reportes y supervision.

## Roles Reales De La Empresa

| Persona | Roles |
| --- | --- |
| Ney | Vendedor, disenador |
| Wendy | Vendedor, disenador |
| Paola | Vendedor, disenador |
| Betty | Vendedor, produccion |
| Camilo | Administrador, disenador |
| Graciela | Admin jefe |
| Marcela | Costura |
| Cristina | Costura |
| Wilson | Costura |
| Yamile | Costura |
| Lidermeyer | Produccion, corte |

Nota: Duvan no queda como trabajador operativo en la app. En roles de trabajo queda solo Camilo.

## Flujo Operativo Oficial

El flujo de pedidos debe quedar asi:

1. Ventas / cierre
2. Diseno / aprobacion
3. Preparacion de archivos
4. Sublimacion / calandra
5. Llego impresion
6. Corte
7. Costura
8. Revision final
9. Listo para entregar
10. Entregado / enviado final

Estados internos principales:

- `bandeja`
- `hacer-diseno`
- `confirmado`
- `enviado-calandra`
- `llego-impresion`
- `corte`
- `costura`
- `en-satelite`
- `calidad` = Revision final
- `listo`
- `enviado-final`

## Lo Que Ya Quedo Hecho

### Entrada Movil

Existe entrada mobile en:

`/#/movil`

Ahora tiene:

- Entrada por area: Ventas, Diseno, Produccion, Costura, Admin.
- Entrada por trabajador: Ney, Wendy, Paola, Betty, Camilo, Graciela, Lidermeyer y costureras.

### Ventas Movil

Objetivo:

- Vendedoras ven cotizaciones.
- Ven pedidos activos.
- Pueden responder rapido al cliente.

Pendiente por mejorar:

- Filtrar por vendedora real.
- Separar mejor Ney/Wendy/Paola/Betty/Graciela segun ventas propias.
- Mostrar saldo/abono cuando exista financiero.

### Diseno Movil

Objetivo:

- Disenadores ven pedidos sin asignar.
- Ven pedidos asignados.
- Pueden marcar diseno listo.
- Pueden enviar a calandra.

Ya se ajusto:

- Camilo queda como admin/disenador.
- Duvan no aparece como rol operativo.

Pendiente por mejorar:

- Filtrar "mis disenos" por trabajador.
- Mejorar acciones para Ney/Wendy/Paola porque tambien venden.
- Historial de quien tomo cada diseno.

### Produccion Movil

Existe vista separada:

`/produccion.html`

Objetivo:

- Usarla en el celular de produccion.
- Ver urgentes primero.
- Avanzar pedidos sin entrar al tablero completo.

Flujo corregido:

- Calandra
- Llego impresion
- Corte
- Costura
- Revision final
- Listo

Pendiente por mejorar:

- Separar mejor Betty y Lidermeyer.
- Crear vista especifica de corte para Lidermeyer si hace falta.
- Registrar quien movio cada pedido.

### Costura Movil

Hay dos tipos de vista:

1. Encargado de costura / produccion:
   - Entra a `/#/satelites`.
   - Ve pedidos por asignar.
   - Puede asignar a Marcela, Cristina, Wilson o Yamile.
   - Tambien puede asignar pedidos que esten en `corte`.

2. Costurera:
   - Entra directo a su link.
   - Solo ve sus pedidos.
   - Toca `Ya termine`.
   - El pedido pasa a `Revision final`, no a listo directo.

Links:

- Marcela: `/#/costura/marcela`
- Cristina: `/#/costura/cristina`
- Wilson: `/#/costura/wilson`
- Yamile: `/#/costura/yamile`

Pendiente por mejorar:

- Que cada costurera vea cantidad/prendas mas claro.
- Foto opcional al terminar.
- Confirmacion simple antes de marcar terminado.
- Historial de costura por persona.

### Admin / Torre De Control

Objetivo:

- Graciela y Camilo ven todo.
- Monitorear estados, atrasos, responsables y cargas.

Ya se agrego:

- Panel de equipo y responsabilidades.
- Carga por persona segun ventas, diseno, produccion, costura y admin.

Pendiente por mejorar:

- Alertas por persona.
- Pedidos sin responsable.
- Pedidos quietos por mas de X horas.
- Reporte diario automatico.
- Vista limpia tipo gerencia.

## Problemas Detectados

1. La app todavia mezcla cosas de admin con pantallas de trabajador.
2. Hay roles combinados que necesitan entrada por persona, no solo por area.
3. Produccion y costura estaban desconectadas porque habia pedidos en `corte` que no aparecian para asignar.
4. La app necesita registrar mejor "quien hizo que".
5. Algunas vistas todavia son utiles pero no suficientemente intuitivas para personas que no manejan tecnologia.
6. El admin necesita mejor monitoreo por persona y por etapa.

## Plan Siguiente

### Fase 1: Verificacion Por Rol

Revisar uno por uno:

- Ney: ventas + diseno
- Wendy: ventas + diseno
- Paola: ventas + diseno
- Betty: ventas + produccion
- Camilo: admin + diseno
- Graciela: admin jefe
- Lidermeyer: produccion + corte
- Marcela/Cristina/Wilson/Yamile: costura

Resultado esperado:

- Cada persona sabe donde entrar.
- Cada persona ve solo lo que necesita.
- Cada accion principal tiene boton grande.
- Admin puede verlo todo.

### Fase 2: Redisenar Pantallas Que Confundan

Prioridad:

1. Costura encargado
2. Costurera personal
3. Produccion / corte
4. Ventas por vendedora
5. Diseno por disenador
6. Torre admin

### Fase 3: Historial Y Responsables

Agregar o mejorar:

- `responsableActual`
- `ultimoResponsable`
- historial de movimientos
- fecha/hora de cada movimiento
- quien hizo la accion

Esto es clave para monitorear.

### Fase 4: Alertas Profesionales

Alertas necesarias:

- Pedido vencido.
- Pedido entrega hoy.
- Pedido sin movimiento.
- Pedido sin disenador.
- Pedido en corte sin asignar a costura.
- Pedido en costura sin volver.
- Pedido en revision final mucho tiempo.

### Fase 5: Tienda Virtual Mas Adelante

La tienda virtual no va primero.

Antes de tienda se necesita:

- Inventario real.
- Stock por producto/talla/color.
- Flujo financiero.
- Catalogo conectado al stock.
- Venta por unidad desde inventario.

Luego si:

- Tienda virtual.
- Catalogo publico.
- Compra por unidad.
- Descuento de stock automatico.

## Criterio De Exito

La app estara bien cuando:

- Un trabajador pueda usarla desde celular sin explicacion larga.
- Una costurera pueda abrir su link y saber que hacer.
- Produccion pueda mover pedidos sin entrar al tablero completo.
- Ventas pueda responder al cliente rapido.
- Diseno pueda ver sus pendientes.
- Admin pueda ver todo y detectar problemas en minutos.

