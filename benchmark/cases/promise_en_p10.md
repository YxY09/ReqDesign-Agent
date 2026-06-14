# PROMISE NFR (English) — Project 10

## Functional Requirements

### F001: The product shall maintain a list of players.

### F002: The product shall allow a user to identify himself or herself as a player.

### F003: Once a game has been initiated  the product shall make the players assigned to the game unavailable for selection from the list of players.

### F004: The product shall allow a user to remove himself or herself from the list of players at any time.

### F005: The product shall make inactive players unavailable for selection from the list of players.

### F006: The product shall remove players who have been inactive for 24 hours from the list of players.

### F007: The product shall allow a player to initiate a game by selecting another available player from the list of players.

### F008: Once a game is initiated  the product shall display a defensive grid to each player

### F009: Once a game is initiated  the product shall display an offensive grid to each player.

### F010: The product shall prevent a player from viewing the offensive or defensive grids of the other player.

### F011: Once a game is initiated  the product shall allow each player to position their 5 ships on their respective defensive grids.

### F012: The product shall allow a player to position ships horizontally on their grid.

### F013: The product shall allow the player to position ships vertically on their grid.

### F014: The product shall allow the player to position ships diagonally on their grid

### F015: The product shall prevent the player from overlapping ships on their grid.

### F016: When both players have positioned their 5 ships on their defensive grids  the product shall define the status of each player for the first turn.

### F017: For each turn  the product shall identify one player as offensive status and one player as defensive status.

### F018: The product shall maintain the status of each player for a turn  either offensive or defensive.

### F019: At the start of each turn  the product shall notify each player of his or her status.

### F020: For each turn  the product shall allow the offensive player to define a shot.

### F021: For each shot  the product shall examine the defensive grid of the defensive player to determine whether the shot was a hit or miss.

### F022: For each shot  the product shall notify the players whether the shot was a hit or miss.

### F023: For each shot  the product shall mark the shot as a hit or miss on the defensive grid of the defensive player.

### F024: For each shot  the product shall mark the shot as a hit or miss on the offensive grid of the offensive player.

### F025: When the hit results in sinking a ship  the product shall notify the players that the ship was sunk.

### F026: When the hit results in sinking a ship  the product shall mark the ship as sunk on the defensive grid of the defensive player.

### F027: When the hit results in sinking a ship  the product shall indicate the type of ship sunk on the defensive grid of the defensive player.

### F028: When the hit results in sinking a ship  the product shall mark the ship as sunk on the offensive grid of the offensive player.

### F029: If the shot was marked as a hit  the product shall allow the offensive player to define a shot.

### F030: If the shot was marked as a miss  the product shall change the status of the offensive player to defensive

### F031: If the shot was marked as a miss  the product shall change the status of the defensive player to offensive

### F032: The product shall continue to assign turns until the game is ended.

### F033: The product shall end a game when a hit by the offensive player results in sinking the last of the defensive players ships  which had not been previously marked as sunk.

### F034: The product shall allow a player to end a game at any time during the game.

### F035: When a game is ended  the product shall notify the players that the game is ended.

### F036: The notification of the game ending will include the reason the game is ended (i.e.  a player has won the game or a player has ended the game).

### F037: When a game is ended  the product shall allow each player to identify himself or herself as an available player in the list of players.

### F038: When a game is ended  the product shall allow each player to remove himself or herself from the list of players.

## Non-Functional Requirements

### N001 [Look & Feel]: The product shall simulate the look of ships at sea.

### N002 [Look & Feel]: The product shall display the grids within a circle as a view from a periscope.

### N003 [Look & Feel]: The product shall display each type of ship in a grid using an image of the specific type of ship.

### N004 [Look & Feel]: When the offensive player takes a shot  the product shall simulate the sound of a ship at sea.

### N005 [Look & Feel]: When a shot is marked as a miss  the product shall simulate the sound of a shot missing its target.

### N006 [Look & Feel]: When a shot is marked as a hit  the product shall simulate the sound of a shot hitting its target.

### N007 [Look & Feel]: When a ship is sunk  the product shall simulate the sound of a sinking ship.

### N008 [Availability]: The product shall be available 24 hours per day  seven days per week.

### N009 [Performance]: The product shall able to handle a large number of games simultaneously.

### N010 [Performance]: The response time shall be fast enough to maintain the flow of the game.  The response time shall be no more than 2 seconds for 95% of responses and no more than 4% for the remaining responses.

### N011 [Performance]: The product shall protect the identity of the players. The product shall provide players no access to information that might reveal the identity of another player.

### N012 [Usability]: The product shall be intuitive and self-explanatory.  Nine out ten users shall be able to successfully complete a game with no training.

### N013 [Usability]: The product shall be available to players who understand English  Spanish and French.  The product shall allow the user to select the language upon accessing the product.

### N014 [Security]: The product shall provide players no access to information that might reveal the identity of another player

### N015 [Performance]: The response time shall be fast enough to maintain the flow of the game. The response time shall be no more than 2 seconds for 95% of responses and no more than 4% for the remaining responses.
