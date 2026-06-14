# PURE — Qheadache 1.0 (Puzzle Game SRS)

Source: PURE Plain Dataset — 2003 - qheadache.txt (CC-BY 4.0)

## Product Overview

Qheadache is a standalone computerized sliding block puzzle game. The user moves blocks on a board to solve the puzzle (move the large 2x2 block to the bottom). The game uses the Qt graphical library and supports all Qt-compatible operating systems including Windows.

## Functional Requirements

### F001: The main window shall provide a board (rectangular zone 4x wide by 5x tall, x between 50–100 pixels) and a menu bar.

### F002: The board contains 4 square blocks (side x), 4 rectangular blocks (2x height, x width), 1 horizontal block (x height, 2x width), and 1 large square block (side 2x). Blocks are yellow on a black board, separated by 0.1x margin.

### F003: Left-clicking on a block selects it and enters "Block displacement" state.

### F004: Releasing the left mouse button on a selected block returns to "Block selection" state.

### F005: During "Block movement" state, the selected block follows the mouse without overlapping other blocks or exiting the game zone, keeping at least 0.05x clearance from other blocks.

### F006: The user can undo their last action via menu. Undo is unavailable if there was no previous movement. The undo action itself is considered a movement.

### F007: The user can redo a canceled action via menu. Redo is unavailable if the previous action was not an undo. The redo action itself is considered a movement.

### F008: The product must count and display the time elapsed since the start of play.

### F009: The product must count and display the number of block movements made by the user.

### F010: The game ends when the large 2x2 square block reaches the bottom of the board. All player statistics are frozen at that point.

### F011: If the player's movement count is lower than the highest score in the statistics file, the "Finish Window with Statistics" is displayed prompting the player to enter their name (up to 20 characters) and click OK to save their score.

### F012: If the player's movement count is not a new record, the "Simple Finish Window" is displayed with a "You win!" message and an OK button.

### F013: The player statistics (name, movement count, time) are saved to the statistics file. If 10 records already exist, the one with the highest movement count is replaced.

### F014: A statistics window displays a list of up to 10 player statistics (name, movement count, time) read from the statistics file.

### F015: The user can erase all statistics via menu. The statistics file data is deleted.

### F016: The user can open a previously saved game via a file dialog. The board is redrawn and statistics are restored from the file.

### F017: The user can save the current game. If never saved before, a "Save As" dialog opens. Otherwise, the file is overwritten with current block positions, last 10000 previous positions, movement count, and elapsed time.

### F018: The user can save the current game to a new file via "Save As" dialog. The file stores current block positions, previous positions, movement count, and elapsed time.

### F019: On exit, if the game is unsaved, a dialog asks whether to save. "Yes" triggers Save then closes; "No" closes immediately.

### F020: The user must be able to undo and redo up to the last 1000 actions.

## Non-Functional Requirements

### N001 [Usability]: No qualification is necessary to play. Users range from age 8 to adult.

### N002 [Portability]: The product uses the Qt graphical library and must run on all Qt-supported operating systems. It must be portable to Windows OS.

### N003 [Hardware]: The product requires a keyboard and mouse (or equivalent pointing device). It requires a graphical display of at least 800x600 resolution.

### N004 [Data]: The statistics file stores up to 10 player records. On overflow, the record with the highest movement count is removed.

### N005 [Constraint]: There can be only one user per machine (no multi-user support).

### N006 [Sound]: Sound is not required to play the game (menus, graphics and sounds are used but sound is optional).

## Menu Structure

- **File menu**: Open game, Save Game, Save Game As, Exit (in this order)
- **Edit menu**: Undo, Redo (grayed out when unavailable)
- **Statistics menu**: Display (show statistics window), Erase (delete all statistics)
- **Help menu**: About (displays "Qheadache 1.0 by JeanPhilippe Brossat jp_brossat@yahoo.fr")
