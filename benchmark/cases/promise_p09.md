# PROMISE NFR — Project 9

## 功能需求 (Functional Requirements)

### F001: El proveedor verificará el cliente potencial no válido

### F002: El proveedor enviará un registro de validación de crédito para aplicarlo al sistema de facturación empresarial

### F003: Si un cliente potencial se puntúa en el rango alto, el sistema proporcionará los datos del cliente potencial y la puntuación al sistema empresarial

### F004: La función de lavado de clientes potenciales validará todos los clientes potenciales recibidos por el servicio web para obtener datos válidos

### F005: La función de lavado de clientes potenciales insertará todos los clientes potenciales capturados por el servicio web

### F006: Si el puntaje de los clientes potenciales se encuentra dentro del puntaje promedio alto, entonces será procesado por la funcionalidad ARA

### F007: Si el puntaje de los clientes potenciales se encuentra dentro del promedio medio, un coordinador de inscripciones lo establecerá para la verificación manual a través del sistema de eleads

### F008: Si la puntuación de los clientes potenciales cae dentro del promedio bajo, se devolverá al proveedor proveedor

### F009: La función de lavado de clientes potenciales recopilará información de puntuación académica y de contacto para obtener una puntuación total

### F010: La función de lavado de cables utilizará los parámetros proporcionados por la empresa y las escuelas para puntuar parte del plomo.

### F011: La función de lavado de clientes potenciales devolverá los datos del cliente potencial suministrados al proveedor junto con el motivo del rechazo.

### F012: La función de lavado de cables tendrá una interfaz en la que se pueden mantener los parámetros de datos de los cables

### F013: La función de lavado de clientes potenciales verificará la autenticación y los derechos de los usuarios para realizar actualizaciones de parámetros

### F014: La función de lavado de clientes potenciales almacenará los posibles duplicados de clientes potenciales devueltos por el sistema empresarial.

### F015: Antes de enviar el cliente potencial al sistema empresarial, la función de lavado de clientes potenciales asignará el cliente potencial a un representante de admisiones

### F016: La función de lavado de clientes potenciales recibirá una lista de períodos de representantes disponibles del sistema empresarial

## 非功能需求 (Non-Functional Requirements)

### N001 [Performance]: El tiempo total del ciclo de clientes potenciales debe completarse en 5 minutos para el 90% del volumen de clientes potenciales entre las horas hábiles de 8AM CST a 8PM CST; luego 3 minutos para el 99% del volumen de clientes potenciales fuera del horario comercial.

### N002 [Performance]: Ninguna evaluación de clientes potenciales se completará en un período de tiempo superior a 25 segundos para el 97% de todos los clientes potenciales procesados

### N003 [Performance]: Para clientes potenciales que procesan más de 25 segundos, el sistema registrará el evento y la duración

### N004 [Performance]: El proceso debe ajustarse a las condiciones de tiempo de procesamiento establecidas por el proceso de asignación automática de representantes en el que se asigna un cliente potencial dentro de los 3 minutos del ciclo de vida total

### N005 [Operational]: El proceso de lavado de plomo operará dentro de la estructura de servicio web física establecida

### N006 [Operational]: El proceso de lavado debe utilizar un formato de datos neutral no vinculante, como xml, al recibir y procesar datos de clientes potenciales.

### N007 [Availability]: Los informes de defectos estarán disponibles para las unidades técnicas las 24 horas del día, los 7 días de la semana

### N008 [Maintainability]: Los parámetros de lavado se actualizarán durante las horas de mantenimiento programadas
