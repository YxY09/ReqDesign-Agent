# PROMISE NFR — Project 3

## 功能需求 (Functional Requirements)

### F001: Se asociará una cohorte a un programa de estudio ofrecido por el departamento

### F002: Los administradores del programa y los miembros del personal de enfermería podrán agregar una lista de estudiantes a una cohorte

### F003: Los administradores del programa y los miembros del personal de enfermería podrán agregar un solo estudiante a una cohorte

### F004: Los estudiantes agregados a una cohorte serán elegibles para el Programa de estudios de la cohorte.

### F005: Los administradores del programa y los miembros del personal de enfermería podrán especificar la secuencia preferida de clases para una cohorte determinada.

### F006: Para cada clase dentro de una secuencia para una cohorte, los administradores del programa y los miembros del personal de enfermería podrán especificar en qué trimestre se ofrecerá esa clase.

### F007: Los administradores del programa y los miembros del personal de enfermería podrán agregar nuevas clases a una secuencia de clases

### F008: Los administradores del programa y los miembros del personal de enfermería podrán agregar clases o secciones clínicas a una secuencia de clases

### F009: Los administradores del programa y los miembros del personal de enfermería podrán agregar una nueva cohorte al sistema identificada por mes y año de inicio.

### F010: Los administradores del programa y los miembros del personal de enfermería podrán agregar al sistema nuevas clases para el departamento de enfermería.

### F011: Una clase será una clase no clínica o una clase clínica.

### F012: Una clase no clínica debe especificar el nombre del curso, requisitos de la sala de conferencias y las necesidades del instructor.

### F013: Una clase clínica deberá especificar el nombre del curso, requisitos de la sala de conferencias, necesidades del sitio clínico, necesidades del instructor de conferencias y las necesidades del instructor del laboratorio clínico.

### F014: Los administradores del programa/miembros del personal de enfermería podrán crear un nuevo programa de estudio

### F015: Un programa de estudio constará de un nombre de programa y una lista de las clases requeridas (tanto clínicas como no clínicas) que deben completarse

### F016: Los administradores del programa y los miembros del personal de enfermería deberán tener la capacidad de especificar qué clases se requieren para un programa de estudio

### F017: El sistema podrá mostrar un informe de las clases necesarias para un trimestre determinado para todas las cohortes de todos los programas para fines de planificación de los administradores de programas/miembros del personal de enfermería

### F018: El informe de clases necesarias incluirá (pero no se limitará a) clases que se ofrecerán, número de secciones necesarias, número de laboratorios necesarios y tipos de salones necesarios.

### F019: Las clases para una cohorte determinada no entrarán en conflicto con respecto a la hora y el día en que se ofrecen

### F020: Los administradores del programa y los miembros del personal de enfermería podrán agregar un nuevo centro clínico al sistema

### F021: La información del sitio clínico incluirá (pero no se limitará a) el nombre de la persona de contacto del sitio y la información de contacto.

### F022: Los administradores del programa y los miembros del personal de enfermería podrán agregar una nueva sección de laboratorio clínico para una clase clínica existente en el sistema

### F023: Una sección de laboratorio clínico incluirá el nombre del sitio clínico, el día del instructor de la clase y la hora del laboratorio

### F024: Los administradores del programa y los miembros del personal de enfermería podrán agregar un estudiante que se haya registrado para una clase clínica a una sección de laboratorio clínico para esa clase

### F025: El sistema permitirá que un administrador del programa o un miembro del personal de enfermería retire a un estudiante de una sección de laboratorio clínico

### F026: El sistema permitirá que un administrador del programa/miembro del personal de enfermería traslade a un estudiante de una sección de laboratorio clínico a otra sección de laboratorio clínico correspondiente a la misma clase clínica

### F027: Los administradores del programa/miembros del personal de enfermería podrán cancelar una sección de laboratorio clínico solo si no hay estudiantes registrados para esa sección de laboratorio clínico

### F028: Un administrador del programa/miembro del personal de enfermería podrá agregar un nuevo estudiante de enfermería al sistema

### F029: Un miembro del personal deberá tener la capacidad de gestionar el progreso de un estudiante a tiempo parcial, lo que incluye modificar su secuencia de clases y el cronograma de clases

### F030: El sistema deberá poder mostrar un resumen imprimible para cohortes individuales que incluirá a los estudiantes inscritos en el Programa de estudio, secuencia de clases, progreso de la cohorte a través del programa y el cronograma de finalización.

### F031: El sistema deberá poder mostrar un resumen imprimible para los sitios clínicos individuales que incluirá información sobre los laboratorios que se llevan a cabo en ese sitio para el trimestre determinado

### F032: El sistema podrá mostrar un resumen imprimible para laboratorios clínicos individuales que incluirá (pero no se limitará a) nombre de clase, número de clase, sección de laboratorio, lista de estudiantes inscritos, día(s), instructor(es), hora y lugar.

### F033: El sistema podrá mostrar un resumen imprimible para estudiantes de enfermería individuales que incluirá (pero no se limitará a) nombre del estudiante, ID del estudiante, fecha de admisión de clases, créditos GPA y la cohorte en la que está inscrito el estudiante

### F034: El sistema deberá poder mostrar un resumen imprimible del registro del sistema

### F035: El sistema debe contener información de contacto (correo electrónico y número de teléfono) de todas las personas relevantes para el sistema, incluidos (entre otros) miembros del personal, estudiantes, instructores de conferencias, instructores de laboratorio clínico y administradores de centros clínicos

### F036: El sistema utilizará las direcciones de correo electrónico almacenadas como medio principal para comunicar información a las partes afectadas

### F037: El sistema notificará a las partes afectadas con fines de comunicación de rutina, que incluyen, entre otros, informar a los estudiantes sobre las próximas clases ofrecidas (cronograma) y cuál será/podría ser su horario

### F038: El sistema notificará a las partes afectadas cuando se produzcan cambios que afecten a las clínicas, incluidos, entre otros, los cambios en la capacidad de la sección clínica y las cancelaciones de la sección clínica

### F039: El sistema notificará a las partes afectadas cuando se produzcan cambios que afecten a las clases, incluidas, entre otras, cancelaciones de clases, cambios en los detalles de la sección de clases y cambios en las ofertas de clases para un trimestre determinado

### F040: El sistema notificará a las partes afectadas cuando se produzcan cambios que afecten a las cohortes, incluidos, entre otros, cambios en la secuencia del programa de estudio de una cohorte y cambios en el horario de una semana determinada (laboratorio cancelado esta semana debido a una enfermedad del instructor)

### F041: El sistema notificará a las partes afectadas cuando ocurran cambios que afecten a estudiantes específicos, incluido, entre otros, cambiar el estado de un estudiante de tiempo completo a tiempo parcial y trasladar a un estudiante a una sección clínica diferente.

### F042: Los administradores del programa/miembros del personal de enfermería deberán tener la capacidad de modificar la información relacionada con las cohortes, incluido el identificador de la cohorte, el programa de estudio, la secuencia preferida de clases y los trimestres en los que una cohorte tomará clases específicas

### F043: Los administradores del programa/miembros del personal de enfermería deberán tener la capacidad de modificar la información relacionada con un programa de estudio dentro del Departamento de enfermería, incluido el nombre del programa de estudio y las clases requeridas para ese programa de estudio.

### F044: Los administradores del programa/miembros del personal de enfermería deberán tener la capacidad de modificar la información relacionada con un sitio clínico, incluida la información de contacto y la dirección de la persona de contacto del sitio del nombre del sitio clínico

### F045: Los administradores del programa/miembros del personal de enfermería deberán tener la capacidad de modificar la información relacionada con una sección del laboratorio clínico, incluido el nombre del sitio clínico, el departamento/sección del laboratorio, el día del instructor de la clase y la hora del laboratorio y la información de contacto

### F046: Los administradores del programa/miembros del personal de enfermería deberán tener la capacidad de modificar la información relacionada con un estudiante de enfermería, incluida la identificación del estudiante, el nombre del estudiante, el número de teléfono, el estado del correo electrónico (tiempo completo o parcial) y el programa de estudio.

## 非功能需求 (Non-Functional Requirements)

### N001 [Usability]: El sistema será fácil de usar por parte de los administradores del programa/miembros del personal de enfermería

### N002 [Usability]: Todos los usuarios podrán utilizar el sistema después de un día de formación

### N003 [Usability]: El sistema ayudará al usuario a evitar cometer errores al programar clases y clínicas para los estudiantes de enfermería

### N004 [Usability]: El número de errores notados por los estudiantes se reducirá en un 50% en el primer año

### N005 [Usability]: El sistema será intuitivo para los administradores del programa/miembros del personal de enfermería

### N006 [Usability]: 2 de cada 3 administradores del programa/miembros del personal de enfermería podrán utilizar con éxito el sistema para gestionar la programación de clases y clínicas

### N007 [Usability]: El sistema utilizará símbolos y palabras que sean naturalmente comprensibles para la comunidad de usuarios

### N008 [Usability]: La verborrea utilizada dentro del sistema deberá ser coherente con el español estándar y la terminología de la comunidad de enfermería nacional

### N009 [Performance]: Los miembros del personal deberán poder completar una serie de tareas de manera oportuna

### N010 [Performance]: El tiempo de respuesta de las tareas generales de gestión de los estudiantes no debe exceder los 5 segundos y el tiempo de respuesta de la generación del horario no debe exceder los 30 segundos.

### N011 [Availability]: El sistema estará disponible para su uso entre las 8 a.m. y las 6 p.m.

### N012 [Availability]: El sistema alcanzará el 95% de tiempo de actividad

### N013 [Scalability]: El sistema deberá poder manejar todas las solicitudes/uso de los usuarios durante el horario comercial

### N014 [Scalability]: El sistema atenderá a 10 usuarios simultáneos de 9 a.m. a 5 p.m.

### N015 [Scalability]: El sistema deberá ser capaz de procesar al 100% de los estudiantes de enfermería y sus clases durante los próximos 10 años

### N016 [Scalability]: Se espera que el sistema gestione el plan de estudios del programa de enfermería y la programación de clases/clínicas durante un mínimo de 5 años

### N017 [Operational]: El sistema podrá funcionar dentro de un entorno de oficina comercial típico del Departamento de Enfermería de la Universidad DePaul

### N018 [Operational]: El sistema se utilizará dentro de las especificaciones definidas por las computadoras utilizadas por los Administradores del Programa/Miembros del Personal de Enfermería

### N019 [Operational]: El sistema funcionará dentro del sistema operativo Windows XP Professional.

### N020 [Operational]: El sistema debe interactuar con el servidor central de CampusConnect

### N021 [Operational]: El sistema debe interactuar con el servidor central de la facultad.

### N022 [Operational]: El sistema debe interactuar con el servidor maestro del estudiante

### N023 [Operational]: Debemos poder interactuar con cualquier navegador HTML

### N024 [Security]: Solo los usuarios autorizados tendrán acceso a la información del centro clínico

### N025 [Security]: Los administradores del programa/miembros del personal de enfermería son las únicas personas que tendrán acceso a los detalles del sitio clínico

### N026 [Security]: Solo los usuarios autorizados tendrán acceso a la información personal de los estudiantes

### N027 [Security]: La Dra. Susan Poslusny y la Dra. Julie Donalek son las únicas personas que tendrán acceso a la información personal de los estudiantes

### N028 [Security]: Solo los usuarios autorizados tendrán acceso a la parte del sistema que interactúa con CampusConnect.

### N029 [Security]: Criterio de adecuación: la Dra. Susan Poslusny y Karen Sysol son las únicas personas que tendrán acceso a la programación de la sección final de la clase para el sistema que interactúa con CampusConnect.

### N030 [Security]: El sistema deberá tener una verificación básica de la integridad de los datos para reducir la posibilidad de que se introduzcan datos incorrectos o no válidos

### N031 [Security]: El sistema protegerá la información privada de acuerdo con la política de información de la organización.

### N032 [Security]: El sistema se construirá de manera que sea lo más seguro posible frente a interferencias maliciosas.

### N033 [Security]: El sistema utilizará el software de protección antivirus estándar de la organización para ayudar a monitorear las amenazas a sí mismo
