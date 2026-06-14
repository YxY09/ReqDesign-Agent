# PROMISE NFR — Project 4

## 功能需求 (Functional Requirements)

### F001: El Sistema de Disputas debe ser accesible tanto para usuarios internos como externos

### F002: El Sistema de Disputas debe evitar que los usuarios accedan a casos de disputas que no pertenezcan a su base de titulares de tarjetas

### F003: El Sistema de Disputas facilitará la entrada directa de datos de un caso de disputa a través de una interfaz de usuario que admite respuestas en tiempo real a los usuarios.

### F004: El Sistema de Disputas debe proporcionar diferentes niveles de acceso con respecto a las acciones de iniciación y seguimiento de casos de controversias

### F005: El Sistema de Disputas proporcionará la capacidad de acceso a la vista para los usuarios autorizados de la aplicación

### F006: El Sistema de Disputas proporcionará la capacidad de acceso a la actualización para los usuarios autorizados de la aplicación

### F007: El Sistema de Disputas debe permitir a los usuarios seleccionar transacciones disputables (según la antigüedad de la transacción) desde una interfaz de usuario e iniciar una disputa (solicitud de recuperación de boleto o notificación de contracargo) en la transacción seleccionada.

### F008: El Sistema de Disputas debe brindar al usuario la capacidad de iniciar un solo caso de disputa en múltiples transacciones que pertenecen a un solo comerciante.

### F009: El Sistema de Disputas proporcionará al usuario la capacidad de crear o iniciar una solicitud de recuperación de tickets. Como parte del proceso de creación de recuperación de tickets, el sistema debe solicitar al usuario que ingrese toda la información necesaria para crear la solicitud de recuperación de tickets. La solicitud de recuperación de boleto es un documento que se envía al comerciante para consultar la validez de una transacción.

### F010: El Sistema de Disputas debe permitir al usuario crear tres tipos únicos de solicitudes de recuperación de tickets. Los tres tipos de solicitudes de recuperación de boletos son (1) Solicitud de recibo original (2) Solicitud de una copia del recibo o (3) Solicitud de un portafolio. Un portafolio consiste en documentación que proporcionaría prueba de una compra, como la documentación que se recibe de una agencia de alquiler de automóviles que es más que un recibo de venta.

### F011: El Sistema de Disputas debe evitar que los usuarios externos soliciten recibos originales. Las solicitudes de recibos originales están restringidas a usuarios internos.

### F012: El Sistema de Disputas debe proporcionar una confirmación al usuario sobre la creación de una solicitud de recuperación de boletos que contenga la siguiente información; el número de caso de disputa el tipo de recuperación solicitada (copia original o cartera) y la fecha en que vence la respuesta del comerciante.

### F013: El Sistema de Disputas permitirá al usuario crear o iniciar una solicitud de devolución de cargo. El sistema debe solicitar al usuario que ingrese la información requerida para iniciar una solicitud de devolución de cargo. La solicitud de devolución de cargo da como resultado una notificación de devolución de cargo impresa que se envía al comerciante indicando que se realizará el cargo en su cuenta si no se proporciona prueba de que la transacción en disputa es válida.

### F014: El Sistema de Disputas debe proporcionar una confirmación al usuario sobre la creación de una solicitud de devolución de cargo. La confirmación debe contener la siguiente información: el número de caso de disputa el tipo de contracargo solicitado (pendiente o inmediato) y la fecha en que vence la respuesta del comerciante.

### F015: El Sistema de Disputas evitará la creación de solicitudes de disputas duplicadas el 100% del tiempo

### F016: El Sistema de Disputas proporcionará con precisión una lista de posibles códigos de motivo para una transacción determinada. La lista de posibles códigos de motivo debe derivarse en función del tipo de transacción y la industria a la que pertenece el comerciante de acuerdo con las reglas comerciales definidas para el Sistema de disputas.

### F017: El Sistema de Disputas debe proporcionar la capacidad de ver los casos de disputa existentes

### F018: El Sistema de Disputas debe proporcionar funcionalidad de búsqueda. El método de búsqueda debe incluir la capacidad de buscar por (1) el número de caso de disputa (2) el número de cuenta del comerciante (3) el número de cuenta del titular de la tarjeta y (4) el número de emisor. Además de los criterios anteriores, la función de búsqueda debe permitir al usuario limitar los resultados de la búsqueda por un rango de fechas, el tipo de disputa (solicitud de recuperación de ticket o notificación de contracargo), el estado del caso (abierto cerrado o todo) y el motivo de la disputa.

### F019: Se debe proporcionar al usuario una lista de todos los casos de disputas que cumplan con los criterios de búsqueda ingresados. La lista de casos debe diferenciar el tipo y/o el estado del caso codificando con colores el elemento de línea de la lista. Por ejemplo, todos los casos abiertos serán amarillos y todos los casos cerrados serán grises.

### F020: El Sistema de Disputas proporcionará a los usuarios la capacidad de ver el historial de todas las actividades que han ocurrido en el caso de disputa

### F021: El Sistema de Disputas proporcionará a los usuarios la capacidad de dar seguimiento a un caso de disputa a través de acciones de seguimiento. La lista de acciones de seguimiento disponibles para un caso de disputa determinado debe filtrarse por el estado del caso y el nivel de acceso del usuario.

### F022: El Sistema de Disputas registrará el nombre del usuario y la fecha de cualquier actividad que cree o modifique el caso de disputas en el sistema. Se debe mantener un historial detallado de las acciones tomadas en el caso, incluida la fecha y el usuario que realizó la acción, para fines de auditoría.

### F023: Para cualquier acción sistemática (no iniciada por el usuario) que ocurra en un caso como el proceso de envejecimiento de disputas, se generará una actividad de caso. En el siguiente inicio de sesión, se debe notificar al usuario que inició el caso de disputa que se ha producido una acción sistemática en el caso de disputa.

### F024: Todas las solicitudes de cartas deben formatearse de acuerdo con las pautas especificadas por el sistema Print Letter Utility.

### F025: Cualquier caso de disputas que se haya cerrado durante más de 6 meses debe eliminarse de la base de datos de disputas en línea

## 非功能需求 (Non-Functional Requirements)

### N001 [Look & Feel]: La aplicación Disputas deberá cumplir con los estándares corporativos para la creación de interfaces de usuario para aplicaciones de uso interno y externo

### N002 [Look & Feel]: Todas las pantallas creadas como parte de la aplicación Disputas deben cumplir con los estándares corporativos para la creación de interfaces

### N003 [Usability]: La lista de casos de disputa que se muestra después de realizar una búsqueda debe estar codificada por colores para una fácil identificación de los casos de disputa según el estado del caso de disputa.

### N004 [Usability]: El 100% de los titulares de tarjetas y los representantes de servicios comerciales utilizarán la aplicación Disputas con regularidad después de un curso de capacitación de 2 días

### N005 [Usability]: El 100% de los representantes de servicios para titulares de tarjetas podrán crear con éxito un caso de disputa en el primer encuentro después de completar el curso de capacitación

### N006 [Usability]: El 100% de los representantes de servicios comerciales podrán realizar con éxito una acción de seguimiento en un caso de disputa en el primer encuentro después de completar el curso de capacitación

### N007 [Performance]: El tiempo máximo de espera para que un usuario navegue de una pantalla a otra dentro de la aplicación Disputas no será superior a 5 segundos

### N008 [Performance]: La aplicación Disputas admitirá 350 usuarios simultáneos sin ninguna degradación del rendimiento de la aplicación

### N009 [Operational]: La aplicación Disputas estará disponible las 24 horas del día, los 7 días de la semana, los 365 días del año, con la excepción de las siguientes ventanas de mantenimiento programadas. Lunes - Sábado 3:00 am a 4:00 am EST Domingo 1:00 amd a 5:00 am EST

### N010 [Operational]: La aplicación Disputas deberá interactuar con la Base de datos de declaraciones. La base de datos de estados de cuenta proporciona los detalles de la transacción al sistema de disputas. Todos los detalles de la transacción deben obtenerse de la base de datos de estados de cuenta

### N011 [Operational]: La aplicación Disputas debe interactuar con la Base de datos de información del titular de la tarjeta. La base de datos de información del titular de la tarjeta proporciona información detallada con respecto a un titular de la tarjeta. Toda la información detallada del titular de la tarjeta debe obtenerse de la base de datos de información del titular de la tarjeta.

### N012 [Operational]: Las aplicaciones de Disputas deberán interactuar con la Base de Datos de Información del Comerciante. La base de datos de información del comerciante proporciona información detallada con respecto al comerciante. Toda la información detallada del comerciante se obtendrá de la base de datos de información del comerciante.

### N013 [Operational]: La aplicación Disputas deberá interactuar con la aplicación Cartas. Esto permitirá que la aplicación Disputas solicite cartas como parte del proceso de iniciación y seguimiento de la disputa. Todas las solicitudes de cartas deben enviarse a la aplicación Print Letter Utility.

### N014 [Operational]: La aplicación de Disputas debe interactuar con el Sistema de Contabilización y Facturación del Titular de la Tarjeta. Esto permitirá que la aplicación Disputas solicite ajustes a las cuentas del titular de la tarjeta y del comerciante. Todas las solicitudes de ajuste deben enviarse al Sistema de registro y facturación del titular de la tarjeta.

### N015 [Security]: La aplicación Disputas garantizará que solo los usuarios con el nivel de acceso adecuado puedan iniciar solicitudes de disputa

### N016 [Security]: Solo los usuarios con acceso a la Actualización deben poder iniciar solicitudes de disputa

### N017 [Security]: La aplicación Disputas garantizará que solo los usuarios autorizados puedan iniciar sesión en la aplicación

### N018 [Security]: Todos los usuarios autorizados una vez autenticados deben poder iniciar sesión en el Sistema de disputas

### N019 [Security]: El Sistema de Disputas generará un Informe de Usuario que detalla cualquier nuevo usuario que se haya agregado y cualquier cambio en el nivel de acceso de un usuario existente. El informe se revisará con fines de auditoría.

### N020 [Security]: Todas las adiciones de nuevos usuarios y las modificaciones al acceso de los usuarios se registrarán en el Informe de usuario

### N021 [Security]: Si se revoca una cuenta de usuario, solo el administrador del sistema puede volver a crear una instancia

### N022 [Security]: Solo el administrador del sistema podrá restablecer una cuenta de inicio de sesión de usuario revocada

### N023 [Security]: La aplicación Disputas manipulará y visualizará los datos comerciales. Los usuarios no tendrán acceso directo a los archivos de datos o bases de datos.

### N024 [Security]: Todas las actualizaciones de los archivos de datos o la base de datos deben iniciarse desde el Sistema de disputas

### N025 [Legal]: La aplicación de Disputas debe cumplir con los requisitos legales especificados en el Reglamento Operativo de Comerciantes

### N026 [Legal]: Todas las reglas de negocio especificadas en el Sistema de Disputas deberán cumplir con el Reglamento Operativo de Comerciantes

### N027 [Legal]: La solicitud de Disputas debe cumplir con los requisitos legales especificados por la Regulación E y la Regulación Z que rigen el procesamiento de disputas de tarjetas de crédito.

### N028 [Legal]: Todas las reglas comerciales especificadas en el Sistema de Disputas deberán cumplir con las directrices de la Regulación E y la Regulación Z

### N029 [Legal]: La aplicación Disputas debe mantener un historial detallado de cada acción que realiza un usuario en un caso de disputa. Esto asegura una pista de auditoría completa si surgen preguntas más adelante con respecto a un caso de disputa en particular.

### N030 [Legal]: Todas las acciones que modifiquen un caso de disputa existente deben registrarse en el historial del caso
