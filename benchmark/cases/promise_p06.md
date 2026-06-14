# PROMISE NFR — Project 6

## 功能需求 (Functional Requirements)

### F001: El producto deberá registrar las entradas de las reuniones

### F002: El producto notificará a los empleados sobre las invitaciones a reuniones

### F003: El producto deberá tener la capacidad de enviar recordatorios de reuniones a los empleados

### F004: El producto asignará la información de contacto de los organizadores a cada reunión que creen

### F005: El producto registrará los reconocimientos de reuniones

### F006: El producto almacenará nuevas salas de conferencias.

### F007: El producto actualizará las salas de conferencias existentes.

### F008: El producto podrá eliminar salas de conferencias.

### F009: El producto podrá almacenar nuevos equipos de sala

### F010: El producto actualizará el equipamiento de la sala existente.

### F011: El producto podrá eliminar el equipo de la sala

### F012: El producto permitirá que un organizador invite a otros empleados a las reuniones

### F013: Cada vez que se reserve una sala de conferencias, el horario de la sala de conferencias se actualizará para reflejar la fecha y la hora de la reserva

### F014: El producto registrará el estado de transporte del equipo reservado

### F015: El producto deberá mostrar un mapa del edificio de la empresa que muestre la ubicación de las salas de conferencias

### F016: El producto registrará agendas de reuniones actualizadas

### F017: El producto enviará una confirmación de la reunión al organizador de la reunión.

### F018: El producto mostrará el equipo de la sala de acuerdo con los parámetros de búsqueda

### F019: El producto mostrará salas de conferencias de acuerdo con los parámetros de búsqueda

### F020: El producto registrará diferentes tipos de reuniones

### F021: El producto registrará todos los equipos que se hayan reservado

### F022: El producto notificará al personal del desarrollo las solicitudes de transporte de equipos

### F023: El producto permitirá a los usuarios privilegiados ver los horarios de las reuniones en múltiples vistas de informes.

### F024: El producto podrá enviar notificaciones de reuniones a través de diferentes tipos de métodos especificados por el usuario final

### F025: El producto debe tener un aspecto y una sensación personalizables

### F026: El producto debe tener una interfaz de usuario intuitiva

### F027: El producto mostrará un estado disponible para las salas de conferencias no reservadas.

## 非功能需求 (Non-Functional Requirements)

### N001 [Operational]: El producto debe funcionar con la mayoría de los sistemas de gestión de bases de datos (DBMS) del mercado, ya sea que el DBMS esté ubicado con el producto en la misma máquina o en una máquina diferente en la red informática

### N002 [Operational]: El producto funcionará junto con el software del servidor en cualquier sistema operativo donde se pueda instalar el Java runtime

### N003 [Operational]: El producto requerirá la colaboración con un sistema de gestión de bases de datos (DBMS). El DBMS puede estar ubicado en la misma máquina que el producto o en una máquina separada que resida en la misma red informática.

### N004 [Operational]: El producto debe hacer uso de tecnología de servidores web/de aplicaciones. Los ejemplos de código abierto incluyen el servidor web Apache Tomcat y el servidor de aplicaciones JBoss.

### N005 [Operational]: Será necesario integrar con el producto un sistema de gestión de bases de datos como Oracle DB2, MySql o HSQL.

### N006 [Look & Feel]: El aspecto y la sensación del producto deben poder incorporar aspectos de la organización del cliente, como la marca y la identidad del logotipo

### N007 [Look & Feel]: El producto deberá tener un aspecto conservador y profesional

### N008 [Usability]: El producto hará que los usuarios quieran usarlo. El 80% de los usuarios encuestados informan que están usando el producto con regularidad después de las primeras 2 semanas posteriores al lanzamiento.

### N009 [Usability]: El producto debe ser fácil de usar. El 90% de los usuarios podrán reservar con éxito una sala de conferencias dentro de los 5 minutos posteriores al uso del producto.

### N010 [Usability]: El producto proporcionará feedback a los usuarios cuando sea necesario. El 80% de los usuarios encuestados informa que el producto confirma con precisión sus acciones.

### N011 [Usability]: El producto permitirá al usuario seleccionar un idioma elegido de uno de los países del mercado de destino

### N012 [Usability]: El producto permitirá la personalización de la página de inicio y las preferencias de visualización

### N013 [Usability]: Un empleado podrá utilizar con éxito el producto en unos pocos minutos. Después de navegar informalmente por el producto durante menos de 15 minutos, los usuarios podrán organizar reuniones y reservar salas de conferencias con éxito.

### N014 [Usability]: El producto utilizará un menú de navegación estándar familiar para la mayoría de los usuarios de la web.

### N015 [Usability]: El producto permitirá la búsqueda intuitiva de las salas de conferencias disponibles

### N016 [Usability]: El producto debe cumplir con la Ley para Estadounidenses con Discapacidades (ADA)

### N017 [Performance]: La respuesta debe ser lo suficientemente rápida para evitar interrumpir el flujo de pensamiento del usuario. El 90% de las tareas se completarán en 5 segundos. El 98% de las tareas se completarán en 8 segundos.

### N018 [Availability]: Aparte de la falla del servidor, el producto de software alcanzará el 99,99% de tiempo de actividad

### N019 [Fault Tolerance]: El producto creará un registro de excepciones de los problemas encontrados dentro del producto para su transmisión a nuestra empresa para su análisis y resolución

### N020 [Scalability]: El producto deberá ser capaz de gestionar hasta 1000 solicitudes simultáneas. Este número aumentará a 2000 para la versión 2. La capacidad de simultaneidad debe poder manejar las horas pico de programación, como las primeras horas de la mañana y las últimas de la tarde.

### N021 [Scalability]: El producto podrá procesar 10000 transacciones por hora dentro de los dos años siguientes a su lanzamiento. Este número aumentará a 20000 en la versión 2.

### N022 [Scalability]: Se espera que el producto funcione durante al menos 5 años para cada instalación del cliente

### N023 [Operational]: El producto se utilizará en entornos de oficina.

### N024 [Operational]: El producto debe poder interactuar con cualquier navegador HTML. El producto transmitirá datos entre el usuario y el producto sin problemas. El producto mostrará HTML correctamente en el 80% de todos los navegadores HTML probados (el mínimo es probar 8 navegadores).

### N025 [Operational]: El producto debe poder interactuar con varios sistemas de gestión de bases de datos. El producto se comunicará satisfactoriamente con el sistema de gestión de la base de datos en el 100% de todas las transacciones.

### N026 [Operational]: El producto debe poder interactuar con varios servidores de correo electrónico. El producto podrá enviar correo electrónico.

### N027 [Operational]: El producto estará disponible para su distribución a través de Internet como un archivo binario o ZIP

### N028 [Operational]: El producto estará disponible para su distribución como un CD empaquetado.

### N029 [Operational]: El producto estará disponible para licenciamiento como una licencia para un servidor, dos a cinco servidores o cinco o más servidores.

### N030 [Usability]: Se debe poder agregar un nuevo usuario al sistema en 10 minutos. El 90% de los nuevos usuarios pueden iniciar sesión en el sistema en 10 minutos.

### N031 [Maintainability]: El producto debe diseñarse utilizando patrones de diseño y las mejores prácticas de codificación. El 90% de los desarrolladores de software de mantenimiento pueden integrar nuevas funciones en el producto en 2 días hábiles.

### N032 [Maintainability]: El producto debe ser altamente configurable para su uso con varios sistemas de administración de bases de datos para los usuarios finales. El 80% de los usuarios finales pueden integrar nuevos sistemas de gestión de bases de datos con el producto sin cambiar el código de software del producto.

### N033 [Maintainability]: Las versiones de mantenimiento se ofrecerán a los clientes una vez al año. Los lanzamientos no deben tardar más de 5 minutos para que el 80% de la base de clientes se instale.

### N034 [Usability]: Cada usuario registrado tendrá acceso al sitio de soporte del producto a través de Internet. El 70% de los usuarios registrados encontrarán una solución a su problema dentro de los 5 minutos posteriores al uso del sitio de soporte.

### N035 [Maintainability]: El cliente podrá integrar fácilmente nuevos mapas de construcción con el producto a lo largo del ciclo de vida del producto. La integración de nuevos mapas con el producto será posible con poco o ningún apoyo del personal de soporte del producto.

### N036 [Usability]: El producto se traducirá a idiomas extranjeros distintos de los idiomas de los países del mercado de destino en versiones futuras. Para cada mercado objetivo emergente, no se necesitarán más de 5 días para configurar el producto para el idioma de ese mercado.

### N037 [Operational]: Se espera que el producto se integre con múltiples sistemas de administración de bases de datos. El producto funcionará con Oracle SQL Server, DB2, MySQL, HSQL y MS Access.

### N038 [Operational]: El producto podrá instalarse en cualquier entorno operativo en un plazo de 2 días

### N039 [Security]: El producto debe garantizar que solo los empleados de la empresa o los usuarios externos con ID de usuario aprobados por la empresa puedan tener acceso al producto. El 100% de todos los inicios de sesión serán realizados por empleados de la empresa o usuarios externos con ID de usuario aprobados por la empresa.

### N040 [Security]: Solo los administradores pueden realizar queries para reservas por usuario. El 100% de todos los queries de reservas por usuario procederá de inicios de sesión de solo inicios de sesión de administradores

### N041 [Security]: El producto debe garantizar que los datos de la base de datos se correspondan con los datos introducidos por el usuario. Cada reserva de sala de conferencias en el sistema contendrá la misma información que ingresó el usuario.

### N042 [Security]: El producto evitará la entrada de datos maliciosos. Los datos del producto y/o de los sistemas de hardware/software adyacentes permanecerán 100% intactos cada vez que se ingresen datos maliciosos en el producto.

### N043 [Fault Tolerance]: El producto y/o las bases de datos/sistemas de archivos dependientes permanecerán operativos como resultado de la entrada de datos maliciosos. El producto y/o las bases de datos/sistemas de archivos dependientes no se bloquearán el 100% del tiempo que se ingresen datos maliciosos en el producto.

### N044 [Security]: El producto deberá tener la capacidad de recibir actualizaciones de software automáticas a medida que surjan nuevas amenazas. El 100% de los clientes podrán recibir actualizaciones de software automáticas transmitidas al producto instalado.

### N045 [Scalability]: El idioma del producto se adaptará a todos los países del mercado de destino. El 90% de los encuestados de cada país del mercado de destino encontrarán que el idioma del producto es aceptable.

### N046 [Usability]: El producto podrá mostrar fechas y horas del calendario de acuerdo con la configuración regional del usuario. El 90% de los encuestados de cada país de mercado objetivo encontrarán que el formato de fecha y hora del producto es correcto.

### N047 [Operational]: El producto debe desarrollarse con las bibliotecas de lenguaje de programación J2SE/J2EE
