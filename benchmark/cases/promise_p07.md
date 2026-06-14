# PROMISE NFR — Project 7

## 功能需求 (Functional Requirements)

### F001: El sistema permitirá la generación de documentos de ajuste de cantidad de inventario a pedido

### F002: El sistema permitirá la generación a pedido de todos los documentos de ajuste de cantidad de inventario desde cierto momento

### F003: El subsistema IQA tendrá en cuenta el estado actual del inventario y ajustará el inventario de ingredientes sustitutivos en consecuencia

### F004: El Sistema permitirá ingresar, almacenar y modificar fórmulas de producto.

### F005: Las fórmulas de los productos permitirán el uso de semiproductos que tengan fórmulas propias

### F006: Los ingredientes de la fórmula del producto permitirán definir los ingredientes sustitutivos

### F007: El subsistema PFE introducirá automáticamente los ingredientes sustitutivos de la fórmula del producto

### F008: Los ingredientes sustitutivos de la fórmula se mantendrán en orden persistente

### F009: El producto permitirá ingresar, almacenar y modificar los menús de productos utilizados por los terminales POS.

### F010: El subsistema PME permitirá crear menús de productos basados en la lista de productos que se mantiene en el sistema contable

### F011: El subsistema PME permitirá mantener submenús dentro de menús y productos dentro de submenús en un orden administrado y persistente

### F012: El subsistema PME permitirá que un producto exista en más de un submenú

### F013: El sistema RMS tendrá el aspecto y la sensación de Windows XP y utilizará futuras GUI para que su uso sea intuitivo

### F014: El sistema generará un documento de ajuste de cantidad de inventario basado en los datos de ventas diarias del producto y las fórmulas del producto.

### F015: El sistema generará un documento de ajuste de cantidad de inventario automáticamente cuando los datos diarios de ventas de productos estén disponibles

## 非功能需求 (Non-Functional Requirements)

### N001 [Performance]: La recreación del ajuste de la cantidad de inventario para el período de los 30 días anteriores no tomará más de 30 minutos

### N002 [Performance]: El sistema permitirá que trabajen al mismo tiempo un mínimo de 6 usuarios

### N003 [Operational]: El sistema utilizará equipos propios informáticos actualizados

### N004 [Operational]: El sistema podrá realizar copias de seguridad automáticas de los datos comerciales y restaurarlos a pedido

### N005 [Security]: El sistema mantendrá una seguridad constante. Cualquier cambio en las contraseñas y/o permisos de los usuarios debería tener efecto en todas las partes del Sistema.

### N006 [Security]: El sistema controlará de forma granular los derechos de acceso a todos los subsistemas principales. Debería ser posible asignar derechos de acceso a todos los subsistemas de forma independiente.

### N007 [Legal]: El Sistema deberá cumplir con todas las normas contables aplicables. La versión final del Sistema debe pasar con éxito una auditoría independiente realizada por un auditor certificado.

### N008 [Operational]: El Sistema no requerirá licencias adicionales de terceros que resulten en tarifas de regalías.
