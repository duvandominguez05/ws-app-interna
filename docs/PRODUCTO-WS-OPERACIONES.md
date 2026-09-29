# Producto W&S Operaciones

Objetivo: que la empresa use una sola app para saber que se vendio, en que estado esta, quien lo tiene, cuanto falta, cuanto se produjo y que se debe facturar.

Regla operativa: si no esta en la app, no existe para produccion.

## Flujo principal

1. Cliente o empresa.
2. Cotizacion.
3. Venta aprobada con abono o pago.
4. Pedido interno.
5. Diseno.
6. Calandra.
7. Corte.
8. Costura.
9. Calidad.
10. Entrega.
11. Factura.

## Que ya sirve

- Facturas.
- Cotizaciones.
- Clientes basicos nacidos desde facturas.
- Registro parcial de calandra.
- Modulos sueltos de costura, pedidos y vigilante.

## Que falta para que tenga proposito

Clientes/Empresas:
- Empresa, NIT/cedula, contacto, telefono, correo, direccion.
- Historial de cotizaciones, ventas, facturas y deuda.
- Condiciones comerciales: anticipo, credito, vendedor responsable.

Ventas/Pedidos:
- Convertir cotizacion en pedido.
- Registrar pago inicial, saldo, fecha prometida y vendedor.
- Adjuntar comprobantes, disenos, archivos y notas.
- Estado unico del pedido.

Produccion:
- Tablero por etapas: nuevo, diseno, calandra, corte, costura, calidad, entrega.
- Responsable actual.
- Fecha de entrega.
- Alertas de atraso.
- Motivo de bloqueo.

Calandra:
- Metros por semana.
- Pedido asociado.
- Operario.
- Material.
- Merma o repeticion.

Costura:
- Lotes por costurera.
- Cantidades asignadas y terminadas.
- Fotos de entrega.
- Pago por prenda o por lote.

Admin:
- Ventas de la semana.
- Pedidos atrasados.
- Produccion pendiente.
- Facturas por cobrar.
- Productividad por area.

## Pantallas que deberian existir primero

1. Inicio operativo: ventas hoy, pedidos atrasados, produccion pendiente, facturas pendientes.
2. Empresas y clientes.
3. Ventas y pedidos.
4. Produccion.
5. Calandra.
6. Costura.
7. Facturas y cotizaciones.

## Como se usa cada rol

Vendedora:
- Crea cotizacion.
- Registra cliente/empresa.
- Confirma pago.
- Convierte a pedido.
- Mira si el pedido esta atrasado.

Diseno:
- Ve solo pedidos asignados.
- Marca listo o bloqueado.
- Adjunta archivo o comentario.

Produccion:
- Recibe pedidos listos de diseno/calandra.
- Asigna corte/costura.
- Actualiza estado real.

Calandra:
- Registra metros, fecha, pedido y responsable.
- Reporta dano, repeticion o pendiente.

Costura:
- Ve lotes asignados.
- Marca terminado con cantidad/foto.
- Admin ve cuanto se debe pagar.

Admin:
- Ve todo.
- Revisa atrasos, saldos, facturacion y productividad.

## Plan de construccion

Fase 1 - Que se use desde hoy:
- Mantener facturas/cotizaciones.
- Ordenar navegacion.
- Crear modulo Clientes/Empresas.
- Crear Venta/Pedido como centro del flujo.
- Crear tablero simple de Produccion.
- Dejar Calandra como registro semanal asociado a pedidos.

Fase 2 - Control real:
- Costura por lotes.
- Pagos a costureras.
- Reportes semanales.
- Alertas de atraso.

Fase 3 - Automatizacion:
- Vigilante en PCs de diseno.
- WhatsApp/Evolution migrado.
- Drive/Gmail.
- IA solo para lectura y ayuda, no como base del proceso.

## Que va al servidor y que queda local

Servidor:
- App web.
- Base de datos.
- Facturas/cotizaciones.
- Clientes/empresas.
- Ventas/pedidos.
- Produccion.
- Calandra/costura.
- Dashboards.

Local:
- Vigilante de carpetas.
- Herramientas de diseno.
- Procesos que no bloquean ventas si un PC se apaga.

