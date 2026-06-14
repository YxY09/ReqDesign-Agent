# PROMISE NFR (English) — Project 6

## Functional Requirements

### F001: The product shall record meeting entries.

### F002: The product will notify employees of meeting invitations.

### F003: The product shall have the ability to send meeting reminders to employees.

### F004: The product shall assign the organizers contact information to each meeting they create.

### F005: The product will record meeting acknowledgements.

### F006: The product shall store new conference rooms.

### F007: The product shall update existing conference rooms.

### F008: The product will be able to delete conference rooms.

### F009: The product shall be able to store new room equipment.

### F010: The product will update existing room equipment.

### F011: The product shall be able to delete room equipment.

### F012: The product shall allow an organizer to invite other employees to meetings.

### F013: Each time a conference room is reserved  the conference room schedule shall be updated to reflect the time and date of the reservation.

### F014: The product shall record the transportation status of equipment reserved.

### F015: The product shall display a map of the company building showing conference room locations.

### F016: The product shall record updated meeting agendas.

### F017: The product shall send a meeting confirmation to the meeting organizer.

### F018: The product shall display room equipment according to search parameters.

### F019: The product shall display conference rooms according to search parameters.

### F020: The product shall record different meeting types.

### F021: The product shall record all the equipment that has been reserved.

### F022: The product shall notify building personnel of equipment transport requests.

### F023: The product will allow priviledged users to view meeting schedules in multiple reporting views.

### F024: The product shall be able to send meeting notifications via different kinds of end-user specified methods.

### F025: The product shall have a customizable Look and Feel.

### F026: The product shall have an intuitive user interface.

### F027: The product will display an available status for unreserved conference rooms.

## Non-Functional Requirements

### N001 [Operational]: The product must work with most database management systems (DBMS) on the market  whether the DBMS is colocated with the product on the same machine or is located on a different machine on the computer network.

### N002 [Operational]: The product will function alongside server software on any operating system where the Java runtime can be installed.

### N003 [Operational]: The product will require collaboration with a database management system (DBMS).  The DBMS may be located on the same machine as the product or on a separate machine residing on the same computer network.

### N004 [Operational]: The product must make use of web/application server technology.  Open source examples include Apache web server  Tomcat  and the JBoss application server.

### N005 [Operational]: A database management system such as Oracle  DB2  MySql or HSQL will need to be integrated with the product.

### N006 [Look & Feel]: The products Look and Feel shall be able to incorporate aspects of the customers organization such as logo  branding  and identity

### N007 [Look & Feel]: The product shall have a conservative and professional appearance.

### N008 [Usability]: The product shall make the users want to use it. 80% of the users surveyed report they are regularly using the product after the first 2 weeks post-launch.

### N009 [Usability]: The product shall be easy to use. 90% of users will be able to successfully reserve a conference room within 5 minutes of product use.

### N010 [Usability]: The product shall give users feedback when necessary. 80% of the users surveyed report that the product accurately confirms their actions.

### N011 [Usability]: The product shall allow the user to select a chosen language from one of the target market countries.

### N012 [Usability]: The product shall allow for customization of start page and views preferences.

### N013 [Usability]: An employee will be able to successfully use the product within a few minutes.  After informally navigating the product for less than 15 minutes  users shall be able to successfully setup meetings and reserve conference rooms.

### N014 [Usability]: The product shall use a standard navigation menu familiar to most web users.

### N015 [Usability]: The product shall allow for intuitive searching of available conference rooms.

### N016 [Usability]: The product shall conform to the Americans with Disabilities Act.

### N017 [Performance]: The response shall be fast enough to avoid interrupting the users flow of thought.  90% of tasks shall complete within 5 seconds.  98% of tasks shall complete within 8 seconds.

### N018 [Availability]: Aside from server failure  the software product shall achieve 99.99% up time.

### N019 [Fault Tolerance]: The product shall create an exception log of problems encountered within the product for transmission to our company for analysis and resolution.

### N020 [Scalability]: The product shall be capable of handling up to 1 000 concurrent requests.  This number will increase to 2 000 by Release 2.  The concurrency capacity must be able to handle peak scheduling times such as early morning and late afternoon hours.

### N021 [Scalability]: The product shall be able to process 10 000 transactions per hour within two years of its launch.  This number will increase to 20 000 by Release 2.

### N022 [Scalability]: The product shall be expected to operate for at least 5 years for each customer installation.

### N023 [Operational]: The product shall be used in office environments.

### N024 [Operational]: The product must be able to interface with any HTML browser.  The product shall transmit data between the user and the product without problems. The product shall display HTML properly in 80% of all HTML browsers tested (minimum is to test 8 browsers).

### N025 [Operational]: The product must be able to interface with various database management systems. The product shall communicate successfully with the database management system on 100% of all transactions.

### N026 [Operational]: The product must be able to interface with various email servers. The product shall be able to send email.

### N027 [Operational]: The product shall be available for distribution via the Internet as a binary or ZIP file.

### N028 [Operational]: The product shall be available for distribution as a packaged CD.

### N029 [Operational]: The product will be available for licensing as a one-server  two-five servers  or five-or-more servers license.

### N030 [Usability]: A new user must be able to be added to the system within 10 minutes.  90% of new users are able to log into the system within 10 minutes.

### N031 [Maintainability]: The product must be designed using Design Patterns and coding best practices.  90% of maintenance software developers are able to integrate new functionality into the product with 2 working days.

### N032 [Maintainability]: The product must be highly configurable for use with various database management systems for the end users.  80% of end users are able to integrate new database management systems with the product without changing the products software code.

### N033 [Maintainability]: Maintenance releases will be offered to customers once a year.  The releases shall take no longer than 5 minutes for 80% of the customer base to install.

### N034 [Usability]: Every registered user will have access to the products support site via the Internet.  70% of registered users shall find a solution to their problem within 5 minutes of using the support site.

### N035 [Maintainability]: The customer shall be able to easily integrate new building maps with the product throughout the products lifecycle.  Integration of new maps with the product shall be possible with little to no support from product support staff.

### N036 [Usability]: The product shall be translated into foreign languages other than the target market countries languages in future releases.  For each emerging target market  it shall take no more than 5 days to configure the product for that markets language.

### N037 [Operational]: The product is expected to integrate with multiple database management systems.  The product will operate with Oracle  SQL Server  DB2  MySQL  HSQL  and MS Access.

### N038 [Operational]: The product shall be able to be installed in any operating environment within 2 days.

### N039 [Security]: The product shall ensure that only company employees or external users with company-approved user IDs may have product access.  100% of all logons shall be by either company employees or external users with company-approved user IDs.

### N040 [Security]: Only managers are able to perform search queries for reservations by user.  100% of all search queries for reservations by user shall be from logons of only management logons.

### N041 [Security]: The product shall ensure that the databases data corresponds to the data entered by the user.  Each conference room reservation in the system will contain the same information as was entered by the user.

### N042 [Security]: The product shall prevent the input of malicious data.  The product and/or adjacent hardware/software systems data shall remain 100% uncorrupted each time malicious data is input into the product.

### N043 [Fault Tolerance]: The product and/or dependent databases/filesystems shall remain operational as a result of the input of malicious data.  The product and/or dependent databases/filesystems shall not crash 100% of the time that malicious data is input into the product.

### N044 [Security]: The product shall have the ability to receive automatic software updates as new threats emerge.  100% of customers will be able to receive automatic software updates transmitted to the installed product.

### N045 [Scalability]: The language of the product shall accommodate all of the target market countries. 90% of survey respondents from each target market country will find that the language of the product is acceptable.

### N046 [Usability]: The product shall be able to display calendar dates and times according to the users locale.  90% of survey respondents from each target market country will find that the date and time formatting of the product is correct.

### N047 [Operational]: The product must be developed with the J2SE/J2EE programming language libraries
