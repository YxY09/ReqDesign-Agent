# PROMISE NFR — Project 5

## 功能需求 (Functional Requirements)

### F001: El usuario deberá buscar la instalación de reparación preferida utilizando la ubicación del vehículo y el radio en millas

### F002: Los datos del vehículo incluirán la marca y el modelo del año del vehículo

### F003: La ubicación del vehículo incluirá la dirección de la calle, el estado y el código postal

### F004: El sistema resolverá el código postal para la dirección de la calle, ciudad y estado si se desconoce el código postal.

### F005: El radio de búsqueda debe estar entre 1 y 30 millas

### F006: El sistema debe ubicar la instalación de reparación preferida con las calificaciones más altas para los criterios de entrada

### F007: El ajustador deberá ingresar a la instalación de reparación preferida en la asignación de presupuesto.

### F008: El ajustador podrá anular la facilidad de reparación preferida en la asignación de presupuesto

### F009: La instalación de reparación preferida se devolverá al usuario.

### F010: El sistema devolverá una lista de las instalaciones de reparación dentro del radio si no se puede determinar la instalación de reparación preferida

### F011: El estimador debe buscar piezas recicladas disponibles utilizando información sobre piezas de vehículos envejecidas.

### F012: El estimador buscará piezas recicladas disponibles utilizando una lista de proveedores de piezas preferidos

### F013: El sistema buscará piezas recicladas disponibles para las piezas y los proveedores del vehículo suministrados.

### F014: El estimador buscará por código postal con un radio de 30 millas si no se encuentran partes para los proveedores de partes preferidos

### F015: El sistema conservará las piezas recicladas disponibles y los proveedores devueltos de la búsqueda

### F016: La información disponible sobre piezas recicladas y sus proveedores se devolverán al usuario

### F017: El estimador aplicará las piezas recicladas seleccionadas a la estimación de colisión

### F018: El estimador no aplicará piezas recicladas a la estimación de colisión si no se devuelven piezas disponibles

### F019: El ajustador revisará la estimación de colisión

### F020: El ajustador solicitará una auditoría de las piezas recicladas de la estimación de colisión

### F021: El sistema recuperará los resultados de la búsqueda de piezas recicladas proporcionados al estimador

### F022: El sistema generará un informe de auditoría basado en las piezas recicladas disponibles y la estimación de colisión

### F023: El informe de auditoría incluirá el número total de piezas recicladas utilizadas en la estimación

### F024: El informe de auditoría incluirá el número de piezas recicladas disponibles a partir de los resultados de búsqueda originales

### F025: El informe de auditoría incluirá el porcentaje de piezas recicladas disponibles utilizadas en la estimación

### F026: El informe de auditoría incluirá la puntuación total de la auditoría que suma las partidas individuales

### F027: El informe de auditoría se mostrará al usuario

### F028: El informe de auditoría estará disponible para otros ajustadores en momentos posteriores.

### F029: El usuario deberá seleccionar para ver las calificaciones de la instalación de reparación preferida.

### F030: Se mostrarán al usuario las calificaciones actuales de las instalaciones de reparación.

### F031: El sistema mostrará un conjunto de calificaciones en blanco si aún no hay calificaciones definidas

### F032: El usuario deberá ingresar nuevas calificaciones basadas en el informe de auditoría

### F033: Las calificaciones serán de una escala de 1 a 10

### F034: Las clasificaciones deben incluir categorías para el intento de uso de piezas recicladas y el uso real de piezas recicladas

### F035: El usuario debe seleccionar guardar las calificaciones de la instalación de reparación preferida

### F036: El sistema guardará las calificaciones de las instalaciones de reparación preferidas

## 非功能需求 (Non-Functional Requirements)

### N001 [Operational]: El producto debe ser compatible con Internet Explorer 5.5 y superior

### N002 [Operational]: El producto debe ser compatible con Mozilla Firefox 1.0 y superior

### N003 [Operational]: El producto debe interactuar con el sistema Choice Parts. Esto proporciona la alimentación de datos de piezas recicladas.

### N004 [Operational]: El producto se ejecutará en el hardware existente para todos los entornos.

### N005 [Operational]: El producto se adherirá a las pautas de arquitectura corporativa

### N006 [Look & Feel]: El producto debe cumplir con las Directrices corporativas de interfaz de usuario

### N007 [Look & Feel]: El producto deberá cumplir con el esquema de color corporativo

### N008 [Look & Feel]: La apariencia del producto debe parecer profesional

### N009 [Usability]: El producto será fácil de usar por Ajustadores y Estimadores de Colisiones. El 95% de los Ajustadores y Estimadores de Colisiones encontrarán el producto fácil de usar.

### N010 [Usability]: El producto aumentará la productividad de los estimadores de colisiones. El 80% de los estimadores de colisiones estarán de acuerdo en que su productividad ha aumentado dentro de 1 mes de usar el producto.

### N011 [Usability]: Los usuarios se sentirán satisfechos con el producto. El 85% de todos los usuarios estarán satisfechos con el producto.

### N012 [Usability]: El producto será fácil de aprender por los ajustadores y estimadores de colisiones. El producto se aprenderá con dos días de formación in situ

### N013 [Usability]: El usuario localizará fácilmente las instrucciones mientras usa el producto. La ayuda al usuario se puede encontrar dentro del 90% del sistema.

### N014 [Performance]: La búsqueda de piezas recicladas no tardará más de 15 segundos. Los resultados de la búsqueda se devolverán en menos de 15 segundos.

### N015 [Performance]: La búsqueda de la instalación de reparación preferida no llevará más de 8 segundos. La instalación de reparación preferida se devuelve en 8 segundos

### N016 [Performance]: El informe de auditoría de piezas recicladas se devolverá al usuario en un plazo de 10 segundos. El informe de auditoría se devolverá en un plazo de diez segundos.

### N017 [Performance]: Las calificaciones de las instalaciones de reparación preferidas se guardarán en 5 segundos. El guardado se producirá en 5 segundos.

### N018 [Availability]: El producto se adherirá al programa de disponibilidad en línea de la empresa. La aplicación se desactiva solo dentro del 98% de las interrupciones programadas según el programa de disponibilidad.

### N019 [Availability]: El producto alcanzará un tiempo de actividad del 98%. El producto no fallará más del 2% del tiempo disponible en línea.

### N020 [Scalability]: El producto podrá manejar hasta 1500 usuarios simultáneos. El sistema funcionará con 1500 usuarios por tiempo.

### N021 [Scalability]: El número medio de registros de piezas recicladas por día será de 50000

### N022 [Scalability]: El producto podrá manejar 10000 usuarios simultáneos dentro de los 2 años posteriores al lanzamiento inicial

### N023 [Operational]: Para los estimadores, el producto debe poder ser operado en una instalación de reparación durante condiciones sucias y ruidosas.

### N024 [Operational]: El producto debe interactuar con el sistema ChoiceParts una vez al día aproximadamente a la 1:00 a.m.

### N025 [Operational]: El mantenimiento del producto se incluirá dentro de las ventanas de mantenimiento corporativas establecidas

### N026 [Operational]: El producto debe recibir soporte mediante el centro de soporte corporativo

### N027 [Operational]: Las instalaciones y actualizaciones de productos serán manejadas por el equipo de tecnología de middleware dentro de los plazos de lanzamiento establecidos

### N028 [Security]: Solo los ajustadores pueden solicitar informes de auditoría de piezas recicladas. Ningún usuario sin una función de ajustador deberá solicitar auditorías de piezas recicladas.

### N029 [Security]: Solo los ajustadores con un rol de supervisor pueden actualizar las calificaciones de las instalaciones de reparación preferidas. Los usuarios sin el rol de supervisor no pueden acceder a las calificaciones de las instalaciones de reparación.

### N030 [Security]: Solo los estimadores de colisiones deben buscar piezas recicladas. Los usuarios sin la función de estimador de colisiones no tendrán acceso a la búsqueda de piezas recicladas.

### N031 [Security]: Solo se introducirán en el sistema datos válidos. No se introducirán datos inválidos en el sistema.

### N032 [Security]: Una compañía de seguros no podrá ver los datos de reclamación de otra compañía de seguros

### N033 [Security]: El producto estará libre de virus informáticos

### N034 [Security]: El sistema evitará ataques maliciosos, incluida la denegación de servicio

### N035 [Legal]: El producto debe cumplir con la ley Sarbanes-Oxley.

### N036 [Legal]: El producto deberá cumplir con las leyes de estimaciones relacionadas con el uso de piezas recicladas.

### N037 [Legal]: El producto deberá cumplir con las regulaciones de seguros con respecto al procesamiento de reclamaciones.
