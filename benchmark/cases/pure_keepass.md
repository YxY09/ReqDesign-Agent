# PURE — KeePass Password Safe 1.10 (SRS)

Source: PURE Plain Dataset — 2008 - keepass.txt (CC-BY 4.0)

## Product Overview

KeePass Password Safe is a small, portable, open-source password manager. It stores all user passwords, usernames, email accounts, and URLs in a strongly encrypted database protected by a Master Password and/or key file. The database is portable (transferable via USB stick) and runs on Windows and WINE. There is no backup or recovery mechanism if the Master Password is lost.

## Functional Requirements

### F001: The user can create a new database. The user must set a Master Password (and optionally a key file) with no length limit. The database is encrypted and protected by this Master Key.

### F002: The user can open an existing database by selecting it via file browser and entering the Master Password (and/or key file) to unlock it.

### F003: The user can save changes to the current database. The user can also use "Save As" to save the database under a new name.

### F004: The user can close the database.

### F005: The user can print selected data from the database. Printable fields include: backup entries, password groups, group tree, title, username, password, URL, notes, creation time, last access, last modification, expiry, icon, UUID, and attachment.

### F006: The user can search the database using keywords across usernames, groups, passwords, URLs, notes, and titles. Partial matches (even a single character) are supported.

### F007: The user can import data from CSV files, Code Wallet, Password Safe, and Personal Vault formats.

### F008: The user can export the database.

### F009: The user can add, modify, and delete groups and subgroups to organize entries. Groups must have a name; duplicate group names are allowed.

### F010: The user can add, view, edit, duplicate, and delete entries within groups. Each entry contains: title, username, password, URL, and notes. Not all fields are required.

### F011: The user can change the display language by downloading and applying a language translation file.

### F012: The user can configure Auto-Type sequences — a series of keypresses that KeePass performs and sends to any window or browser.

### F013: The user can pass a file path via command line to open that file at KeePass startup.

### F014: KeePass supports a Composite Master Key combining a password, key file, and/or Windows account details. All components used during creation are required to unlock the database.

### F015: KeePass provides a password generator supporting: random passwords based on character sets, pattern-based passwords, rule-based passwords, and automatically generated passwords for new entries.

### F016: KeePass supports TAN (Transaction Authentication Numbers) for one-time password generation. TANs can be added via the TANs wizard.

### F017: The user can lock the workspace. The database locks automatically when minimized. Unlocking requires the Master Key again.

### F018: KeePass uses a Global Hot Key to restore the main window and enforces single-instance mode (only one instance runs at a time).

### F019: Passwords stored in entries can be sent to websites or applications using: Context-Sensitive Password List, Drag and Drop, Auto-Type, and KeeForm.

### F020: The URL field supports standard URLs, registered protocols, command line execution, and placeholders that are automatically replaced when the URL is executed.

### F021: KeePass provides Secure Edit Controls that display passwords behind asterisks and prevent password theft when enabled.

## Non-Functional Requirements

### N001 [Security]: The database is encrypted using AES/Rijndael (128-bit block, 256-bit key) and Twofish (128-bit block, 256-bit key). A random 128-bit initialization vector is generated on each save. The master key salt and IV bytes are from pseudorandom sources.

### N002 [Security]: All passwords are stored encrypted in process memory using ARC4 encryption with a random 12-byte key.

### N003 [Security]: There is no recovery password or back door. If the Master Password is lost, the database cannot be opened.

### N004 [Security]: A copied password is automatically cleared from the clipboard after 10 seconds.

### N005 [Portability]: KeePass must run on Windows 95/98/NT/2000/XP (32-bit), Windows Server 2003, and WINE. It requires no external dependencies beyond .NET/Mono (Win32).

### N006 [Usability]: KeePass is small and portable — transferable via a simple USB stick.

### N007 [Constraint]: Only one instance of KeePass may run at a time (enforced via single-instance option).

### N008 [Data]: Database files use the .kdb extension. Databases must have unique names to avoid overwriting.
