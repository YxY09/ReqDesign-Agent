# PROMISE NFR — Project 8

## 功能需求 (Functional Requirements)

### F001: El sitio web permitirá a los clientes buscar películas por actor o director

### F002: Al ver los detalles de una película, el sitio web mostrará la descripción de las películas que el actor y el director ingresaron por el administrador.

### F003: El sitio web deberá solicitar y autorizar el pago con tarjeta de crédito antes de permitir que un usuario transmita una película

### F004: Se podrá transmitir la película comprada a través de Windows Media Player hasta 2 días después de la fecha de compra

### F005: El sitio web permitirá a los clientes buscar películas por categorías ingresadas por el administrador de izogn.

### F006: El sitio web permitirá a los clientes ver reseñas de películas seleccionadas por otros clientes

### F007: El sitio web permitirá a los clientes agregar su propia reseña de película para una película seleccionada

### F008: El sitio web permitirá al administrador de Izogn aprobar una revisión publicada por un cliente

### F009: El sistema permitirá a los clientes pagar por una película en streaming con una tarjeta prepaga

### F010: El sitio web permitirá a los clientes comprar tarjetas prepagas por valor de $5, $10 o $20, ya sea mediante tarjeta de crédito o mediante la opción de pago por correo

### F011: El sistema actualizará automáticamente la página principal del sitio web todos los viernes y mostrará las 4 últimas películas que se han agregado al sitio web

### F012: El sistema permitirá a los usuarios actualizar su información de facturación y contacto a través de la sección Mi cuenta del sitio web.

### F013: Las tarjetas prepagas se distribuirán por correo electrónico o mediante una tarjeta de papel impresa

### F014: Solo los clientes registrados pueden comprar películas en streaming

### F015: Las películas solo se pueden transmitir si el cliente ha comprado una película y está dentro del período de 2 días para transmitir la película

### F016: El sitio web debe poder admitir períodos de prueba gratuitos con varios parámetros establecidos por Izogn Manager

### F017: Todas las ventas de películas en streaming se registrarán en la base de datos y el administrador podrá acceder a ellas

### F018: Toda la información del cliente registrado se almacenará y mantendrá en la base de datos incluso después de que el cliente cancele su cuenta

### F019: Las estadísticas de uso diario deben estar registradas y ser accesibles por el administrador

### F020: El propietario tendrá acceso gratuito a todas las películas en streaming

## 非功能需求 (Non-Functional Requirements)

### N001 [Performance]: El administrador podrá activar una tarjeta prepaga a través de la sección Administración en menos de 5 segundos

### N002 [Performance]: El cliente podrá verificar el estado de su tarjeta prepaga ingresando el número PIN en menos de 5 segundos.

### N003 [Performance]: El sistema permitirá que los clientes se registren en el sitio web como un usuario de pago por uso en menos de 5 minutos.

### N004 [Performance]: El sistema permitirá que los clientes se registren en el sitio web como un usuario de suscriptor de películas ilimitado en menos de 10 minutos.

### N005 [Performance]: El sistema permitirá que los clientes existentes inicien sesión en el sitio web con su dirección de correo electrónico y contraseña en menos de 5 segundos

### N006 [Performance]: El sistema permitirá que los clientes cancelen su cuenta. El proceso no llevará más de 2 minutos. La base de datos marcará la cuenta como inactiva y el usuario no podrá iniciar sesión en el sitio web.

### N007 [Performance]: El sistema permitirá al administrador desactivar una cuenta de cliente en menos de 1 minuto. El cliente ya no podrá acceder al sitio web.

### N008 [Performance]: El sistema permitirá al administrador agregar/eliminar películas en el sitio web en menos de 5 minutos. La información de la película ingresada se almacenará en la base de datos y ahora estará disponible en el sitio web.

### N009 [Performance]: El sistema permitirá que el administrador agregue/elimine categorías en el sitio web en menos de 5 minutos

### N010 [Performance]: El sistema permitirá que Izogn Manager acceda a las estadísticas de uso y ventas en menos de 2 minutos

### N011 [Performance]: El sistema permitirá a los administradores generar pines prepagos únicos en menos de 2 minutos y generar un archivo de Excel con los PIN generados.

### N012 [Look & Feel]: El sitio web será atractivo para todos los públicos. El sitio web debe parecer divertido y los colores deben ser brillantes y vibrantes.

### N013 [Look & Feel]: El sitio web debe tener un toque africano, pero no debe alienar a los no africanos. El sitio web debe utilizar animaciones en las páginas que describen los servicios para captar la atención de los usuarios y animarlos a registrarse.

### N014 [Look & Feel]: El diseño del sitio web debe ser moderno, limpio y conciso

### N015 [Usability]: El producto debería poder ser utilizado por el 90% de los usuarios novatos en Internet

### N016 [Usability]: Los usuarios solo deben tener que navegar por un máximo de 4 páginas para crear una cuenta en el sitio web

### N017 [Usability]: Los usuarios deberían poder acceder a sus películas en streaming en menos de 2 clics después de iniciar sesión en el sitio web

### N018 [Usability]: Una encuesta anónima mostrará que el 70% de los clientes se sienten cómodos comprando películas en streaming después de 2 semanas usando el sitio web

### N019 [Usability]: Una encuesta anónima mostrará que el 95% de los clientes se sienten cómodos usando y comprando tarjetas prepagas después de un mes de usar el sistema

### N020 [Usability]: El producto conservará la información y las preferencias de compra del cliente

### N021 [Usability]: El producto será fácil para los clientes principiantes en Internet para comprar y ver películas en tiempo real. Los clientes deberían poder comprar y ver una película predeterminada en menos de 3 minutos.

### N022 [Usability]: El producto utilizará símbolos y palabras que los usuarios familiarizados con los sitios web puedan comprender de forma natural

### N023 [Usability]: El sitio web utilizará las convenciones estándar de Internet al interactuar con el usuario

### N024 [Performance]: Cualquier interfaz entre un usuario y el sistema automatizado tendrá un tiempo de respuesta máximo de 5 segundos, a menos que se indique una excepción a continuación

### N025 [Performance]: Al comprar una película en streaming o una tarjeta prepaga mediante tarjeta de crédito, el tiempo de procesamiento debe tener un tiempo de respuesta máximo de 15 segundos

### N026 [Performance]: Cuando se transmite una película, el tiempo de almacenamiento en búfer no debe ser superior a 10 segundos (más cualquier latencia en la conexión del usuario)

### N027 [Performance]: Mientras se transmite una película, el almacenamiento en búfer solo debe ocurrir si hay latencia en la conexión del usuario

### N028 [Security]: Toda la información de la tarjeta de crédito estará protegida en el servidor y solo podrán acceder a ella los administradores autorizados de Izogn. La información se cifrará en la base de datos.

### N029 [Availability]: El sitio web estará disponible para su uso las 24 horas del día, los 365 días del año

### N030 [Availability]: El sitio web alcanzará el 99,5% de tiempo de actividad

### N031 [Availability]: Todas las películas se transmitirán a pedido en cualquier momento del día

### N032 [Fault Tolerance]: El sitio web seguirá funcionando si el servidor de transmisión deja de funcionar

### N033 [Fault Tolerance]: El sitio web seguirá funcionando si la pasarela de pago deja de funcionar

### N034 [Scalability]: El servidor de transmisión admitirá 50 conexiones de transmisión simultáneas

### N035 [Scalability]: El servidor de transmisión admitirá un máximo de 700 películas; se pueden agregar nuevos servidores para admitir más películas.

### N036 [Scalability]: El servidor admitirá un máximo de 1000 usuarios simultáneos

### N037 [Scalability]: El sitio web deberá tener capacidad para 100000 clientes

### N038 [Maintainability]: Se espera que el producto funcione dentro del presupuesto máximo de mantenimiento durante un mínimo de 2 años

### N039 [Operational]: Se podrá acceder a todos los aspectos del sitio web mediante un navegador web a través de Internet

### N040 [Operational]: Se utilizará el mismo hardware compatible con el sitio web actual para admitir el nuevo sistema

### N041 [Operational]: Debemos poder interactuar con los siguientes navegadores: IE 5.X 6.0, Netscape 6.x 7.x 8.x y Firefox 1.0.

### N042 [Operational]: El sitio web debe interactuar con la API CyberSource para procesar transacciones con tarjeta de crédito

### N043 [Operational]: El sitio web debe estar en pleno funcionamiento con MSN TV2.

### N044 [Operational]: Las películas se codificarán y transmitirán a través de Windows Media Player 9.0.

### N045 [Operational]: Las películas se codificarán para transmisiones de 56k y 256k.

### N046 [Maintainability]: Las actualizaciones promocionales del sitio web deberían tardar un día en actualizarse

### N047 [Performance]: El administrador de Izogn debe poder actualizar los listados de categorías en el sitio web en 2 minutos

### N048 [Performance]: Izogn Administrator debe poder agregar nuevos productos al sitio web en 2 minutos

### N049 [Availability]: El sistema proporcionará un número gratuito 800 las 24 horas para brindar asistencia a sus clientes

### N050 [Usability]: El sitio web proporcionará una sección de ayuda con respuestas y soluciones a problemas comunes

### N051 [Availability]: El personal de Velkat estará disponible para soporte telefónico entre las 7 am y las 7 pm de lunes a viernes para brindar soporte técnico a los administradores de Izogn.

### N052 [Operational]: El producto debe poder instalarse en el entorno especificado dentro de 1 día hábil.

### N053 [Security]: Solo los clientes registrados pueden comprar películas en streaming

### N054 [Security]: Un cliente solo puede transmitir una película si la compró y está dentro del período de visualización de 2 días

### N055 [Security]: Solo el personal autorizado puede acceder a los registros de los clientes en la base de datos

### N056 [Security]: Solo los administradores pueden activar una tarjeta prepago

### N057 [Security]: Solo el personal autorizado puede acceder a la información de ventas

### N058 [Security]: El sitio web evitará que sus datos se corrompan cuando se ingresan datos incorrectos

### N059 [Security]: El sitio web se protegerá a sí mismo de abusos intencionales y notificará al administrador en todos los casos

### N060 [Security]: Se ejecutarán scripts de integridad de datos semanalmente para verificar la integridad de la base de datos

### N061 [Security]: El sitio web debe informar a sus usuarios de sus prácticas de información antes de recopilar datos de ellos a través de una Política de privacidad accesible en todas las páginas del sitio web.

### N062 [Security]: El sistema notificará a los clientes los cambios en su política de información.

### N063 [Security]: El sistema revelará información privada solo de conformidad con la política de información de la organización

### N064 [Security]: Toda la información del cliente se almacenará en una base de datos segura accesible solo para el personal autorizado

### N065 [Security]: Toda la información de la tarjeta de crédito se cifrará en la base de datos

### N066 [Security]: El servidor de transmisión tendrá un software antivirus para evitar la infección de virus maliciosos

### N067 [Look & Feel]: El sitio web debe atender a todas las tribus de Nigeria

### N068 [Look & Feel]: El sitio web no debe ser ofensivo para grupos religiosos o étnicos

### N069 [Look & Feel]: El sitio web debería atraer a todos los africanos, no solo a los nigerianos

### N070 [Operational]: El sitio web debe usar Flash para proporcionar animación en la página de inicio.

### N071 [Legal]: IzognMovies deberá cumplir con los requisitos de licencia establecidos por las organizaciones apropiadas para transmitir películas africanas

### N072 [Legal]: El sitio web cumplirá con los estándares W3C.

### N073 [Legal]: El código PHP cumplirá con los estándares PEAR.
