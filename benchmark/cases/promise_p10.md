# PROMISE NFR — Project 10

## 功能需求 (Functional Requirements)

### F001: El producto deberá mantener una lista de jugadores.

### F002: El producto permitirá al usuario identificarse como jugador

### F003: Una vez que se ha iniciado un juego, el producto hará que los jugadores asignados al juego no estén disponibles para la selección de la lista de jugadores

### F004: El producto permitirá que un usuario se elimine de la lista de jugadores en cualquier momento

### F005: El producto hará que los jugadores inactivos no estén disponibles para la selección de la lista de jugadores

### F006: El producto eliminará de la lista de jugadores a los jugadores que hayan estado inactivos durante 24 horas.

### F007: El producto permitirá que un jugador inicie un juego seleccionando otro jugador disponible de la lista de jugadores.

### F008: Una vez que se inicia un juego, el producto debe mostrar una cuadrícula defensiva para cada jugador

### F009: Una vez que se inicia un juego, el producto mostrará una cuadrícula ofensiva para cada jugador.

### F010: El producto evitará que un jugador vea las cuadrículas ofensivas o defensivas del otro jugador

### F011: Una vez que se inicia un juego, el producto permitirá que cada jugador coloque sus 5 barcos en sus respectivas cuadrículas defensivas.

### F012: El producto permitirá que un jugador coloque los barcos horizontalmente en su cuadrícula

### F013: El producto permitirá al jugador colocar los barcos verticalmente en su cuadrícula.

### F014: El producto permitirá al jugador colocar los barcos en diagonal en su cuadrícula

### F015: El producto evitará que el jugador se superponga a los barcos en su cuadrícula.

### F016: Cuando ambos jugadores hayan colocado sus 5 barcos en sus cuadrículas defensivas, el producto definirá el estado de cada jugador para el primer turno.

### F017: Para cada turno, el producto identificará a un jugador como estado ofensivo y a un jugador como estado defensivo.

### F018: El producto mantendrá el estatus de cada jugador durante un turno ofensivo o defensivo

### F019: Al comienzo de cada turno, el producto notificará a cada jugador su estado.

### F020: Para cada turno, el producto permitirá al jugador ofensivo definir un tiro.

### F021: Para cada disparo, el producto examinará la cuadrícula defensiva del jugador defensivo para determinar si el disparo fue un hit o un error.

### F022: Para cada disparo, el producto notificará a los jugadores si el disparo fue acertado o fallido

### F023: Para cada disparo, el producto marcará el disparo como un hit o un error en la cuadrícula defensiva del jugador defensivo.

### F024: Para cada disparo, el producto marcará el disparo como un hit o un error en la cuadrícula ofensiva del jugador ofensivo.

### F025: Cuando el impacto provoque el hundimiento de un barco, el producto notificará a los jugadores que el barco se hundió.

### F026: Cuando el impacto provoque el hundimiento de un barco, el producto marcará el barco como hundido en la cuadrícula defensiva del jugador defensivo.

### F027: Cuando el impacto provoque el hundimiento de un barco, el producto indicará el tipo de barco hundido en la cuadrícula defensiva del jugador defensivo.

### F028: Cuando el impacto resulte en el hundimiento de un barco, el producto marcará el barco como hundido en la cuadrícula ofensiva del jugador ofensivo.

### F029: Si el tiro fue marcado como un golpe, el producto permitirá al jugador ofensivo definir un tiro.

### F030: Si el tiro fue marcado como un fallo, el producto cambiará el estado del jugador ofensivo a defensivo

### F031: Si el tiro fue marcado como un fallo, el producto cambiará el estado del jugador defensivo a ofensivo

### F032: El producto continuará asignando turnos hasta que finalice el juego

### F033: El producto terminará un juego cuando un impacto del jugador ofensivo provoque el hundimiento del último de los barcos del jugador defensivo que no habían sido previamente marcados como hundidos.

### F034: El producto permitirá a un jugador finalizar un juego en cualquier momento durante el juego.

### F035: Cuando finaliza un juego, el producto notificará a los jugadores que el juego ha terminado.

### F036: La notificación del final del juego incluirá el motivo por el que finalizó el juego (es decir, un jugador ha ganado el juego o un jugador ha terminado el juego).

### F037: Cuando finaliza un juego, el producto permitirá que cada jugador se identifique como un jugador disponible en la lista de jugadores.

### F038: Cuando finaliza un juego, el producto permitirá que cada jugador se elimine de la lista de jugadores.

## 非功能需求 (Non-Functional Requirements)

### N001 [Look & Feel]: El producto simulará el aspecto de los barcos en el mar

### N002 [Look & Feel]: El producto debe mostrar las cuadrículas dentro de un círculo como una vista desde un periscopio

### N003 [Look & Feel]: El producto mostrará cada tipo de barco en una cuadrícula utilizando una imagen del tipo específico de barco

### N004 [Look & Feel]: Cuando el jugador atacante realiza un tiro, el producto simulará el sonido de un barco en el mar

### N005 [Look & Feel]: Cuando un disparo se marca como fallado, el producto simulará el sonido de un disparo que no alcanza su objetivo

### N006 [Look & Feel]: Cuando un disparo se marca como un impacto, el producto simulará el sonido de un disparo al dar en el blanco.

### N007 [Look & Feel]: Cuando se hunde un barco, el producto simulará el sonido de un barco que se hunde

### N008 [Availability]: El producto estará disponible las 24 horas del día, los siete días de la semana

### N009 [Performance]: El producto podrá manejar una gran cantidad de juegos simultáneamente

### N010 [Performance]: El tiempo de respuesta será lo suficientemente rápido para mantener el flujo del juego. El tiempo de respuesta no será superior a 2 segundos para el 95% de las respuestas ni superior al 4% para el resto de respuestas.

### N011 [Performance]: El producto protegerá la identidad de los jugadores. El producto no proporcionará a los jugadores acceso a información que pueda revelar la identidad de otro jugador.

### N012 [Usability]: El producto debe ser intuitivo y autoexplicativo. Nueve de cada diez usuarios podrán completar con éxito un juego sin entrenamiento.

### N013 [Usability]: El producto estará disponible para jugadores que entiendan inglés, español y francés. El producto permitirá al usuario seleccionar el idioma al acceder al producto.

### N014 [Security]: El producto no proporcionará a los jugadores acceso a información que pueda revelar la identidad de otro jugador

### N015 [Performance]: El tiempo de respuesta será lo suficientemente rápido para mantener el flujo del juego. El tiempo de respuesta no será superior a 2 segundos para el 95% de las respuestas ni superior al 4% para el resto de respuestas.
