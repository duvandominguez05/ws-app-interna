# Flujo de Trabajo Oficial — W&S Textil
Este documento detalla el proceso end-to-end de la fábrica para servir como base lógica del ERP Empresarial.

---

## 1. Captación y Cierre (Ventas)
*   **Entrada**: Pregunta del cliente por uniformes personalizados.
*   **Atención**: Los vendedores gestionan la duda.
*   **Cierre**: Se confirma la venta. 
*   **Validación**: El cliente envía pantallazo de consignación (50% inicial).
*   **Integración ERP**: El sistema debe detectar/leer esto desde **Chatwoot**.

## 2. Diseño Digital y Aprobación
*   **Asignación**: Los diseñadores entran a la conversación del cliente.
*   **Proceso**: Se crea el diseño digital (mockup) de cómo quedará la prenda.
*   **Aprobación**: Comunicación constante con el cliente hasta que apruebe el diseño digital. No se inicia producción física sin esta aprobación.

## 3. Preparación de Archivos (Pre-Producción)
*   **Organización**: Los diseñadores organizan las piezas por Nombre, Talla y Número.
*   **Herramientas**: Se usa la app de **Nesting** para optimizar piezas.
*   **Exportación**: Archivos finales hechos en **CorelDRAW** y exportados a **PDF**.
*   **Envío**: Se mandan por correo a la Calandra vía **WeTransfer** (archivos > 2GB).

## 4. Sublimación y Calandra (Maquila)
*   **Logística**: Se lleva la tela virgen a la Calandra (servicio externo).
*   **Proceso**: Entregan la tela impresa y sublimada lista para el corte.
*   **Retorno**: La Calandra avisa para recoger; se trae la tela de vuelta a la fábrica.

## 5. Corte y Organización
*   **Acción**: Se cortan las piezas sublimadas.
*   **Verificación**: Se organizan los paquetes para costura asegurando que **el pedido esté completo** (que no falte ninguna pieza ni talla).

## 6. Confección (Costura)
*   **Acción**: Ensamble de las piezas (camisetas, pantalonetas, chaquetas, etc.).
*   **Responsables**: Costureros y Satélites.

## 7. Control de Calidad y Entrega Final
*   **Revisión**: Llegan las prendas listas; se verifica que todo esté correcto (tallas, nombres, escudos).
*   **Cobro**: Se alista para envío y se avisa al cliente que el pedido está listo.
*   **Pago Final**: El cliente paga el **50% faltante**.
*   **Despacho**: Se entrega/envía el pedido una vez el saldo sea cero.

---

## Objetivo del ERP Profesional
*   **Escalabilidad**: Capacidad para manejar muchos empleados y pedidos sin desorden.
*   **Visibilidad**: Que el dueño sepa en qué paso (1 al 7) está cada pedido en tiempo real.
*   **Profesionalismo**: Interfaz nivel multinacional (React + TypeScript + Socket.io).
