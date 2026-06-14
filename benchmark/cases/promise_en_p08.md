# PROMISE NFR (English) — Project 8

## Functional Requirements

### F001: The website will allow customers to search for movies by title  actor  or director.

### F002: viewing a movie details  the website will display the movies description  actor  and director entered in by the administrator.

### F003: Website shall request  and authorize credit card payment before allowing a user to stream a movie.

### F004: shall be able to stream purchased movie via Windows Media Player  for up to 2 days aftere purchase date.

### F005: Website shall allow customers to browse movies by categories entered in by izogn administrator.

### F006: Website shall allow customers to view reviews of selected movies by other customers.

### F007: Website shall allow customers to add their own movie review for a selected movie.

### F008: Website shall allow the Izogn administrator to approve a review posted by a customer.

### F009: System will allow customers to pay for a streaming movie with a pre-paid card.

### F010: Website shall allow customers to purchase pre-paid cards of $5  $10  or $20 value either by credit card or mail-in payment option.

### F011: System shall automatically update the main page of the website every Friday  and show the 4 latest movies that have been added to the website.

### F012: System shall allow users to update their billing and contact information via the My Account section of the website.

### F013: Pre-paid cards shall be distributed via email  or via a printed paper card.

### F014: Only registered customers can purchase streaming movies.

### F015: Movies can only be streamed if the customer has purchased a movie  and is within the 2-day time period to stream the movie.

### F016: Website must be able to support free trial periods with various parameters set by the Izogn Manager.

### F017: All streaming movie sales will be logged in the database  and accessible by the administrator.

### F018: All registered customer information shall be stored and maintained in the database  even after the customer cancels their account.

### F019: Daily usage statistics should be logged  and accessible by the administrator.

### F020: The owner shall have free access to all of the streaming movies.

## Non-Functional Requirements

### N001 [Performance]: Administrator shall be able to activate a pre-paid card via the Administration section in under 5 seconds.

### N002 [Performance]: Customer shall be able to check the status of their prepaid card  by entering in the PIN number  in under 5 seconds.

### N003 [Performance]: System shall let customers register on the website as a pay as you go user in under 5 minutes.

### N004 [Performance]: System shall let customers register on the website as a unlimited movie subscriber user in under 10 minutes.

### N005 [Performance]: System shall let existing customers log into the website with their email address and password in under 5 seconds.

### N006 [Performance]: System shall let customers cancel their account  process shall take no longer than 2 minutes.  Database will mark the account as inactive  and user will not be able to log into the website.

### N007 [Performance]: System shall let administrator de-activate a customer account in under 1 minute. Customer will no longer be able to access the website.

### N008 [Performance]: System shall let administrator add/remove movies on the website in under 5 minutes.  Entered movie information will be stored in the database and will now be available on the website.

### N009 [Performance]: System shall let the administrator add/remove categories on the website in under 5 minutes.

### N010 [Performance]: System shall let Izogn Manager access sales and usage statistics in under 2 minutes.

### N011 [Performance]: System shall let administrators generate unique pre-paid pins in under 2 minutes and generate an Excel file with the generated PINs.

### N012 [Look & Feel]: The website shall be attractive to all audiences.  The website shall appear to be fun and the colors should be bright and vibrant.

### N013 [Look & Feel]: The website should have an African feel  but should not alienate non-Africans.  The website should use animation on pages which are describing the services  to grab the users attention and encourage them to sign up.

### N014 [Look & Feel]: The website design should be modern  clean  and concise.

### N015 [Usability]: The product should be able to be used by 90% of novice users on the Internet.

### N016 [Usability]: Users should only have to navigate through a maximum of 4 pages  to create an account with the website.

### N017 [Usability]: Users should be able to access their streaming movies in under 2 clicks after logging into the website.

### N018 [Usability]: An anonymous survey will show that 70% of customers are comfortable purchasing streaming movies after 2 weeks using the website.

### N019 [Usability]: An anonymous survey will show that 95% of customers are comfortable using and purchasing pre-paid cards after a month of using the system.

### N020 [Usability]: The product shall retain the customers buying preferences and information.

### N021 [Usability]: The product shall be easy for customers with novice skills on the  Internet to purchase and watch streaming movies.  Customers should be able to purchase and watch a pre-determined movie in under 3 minutes.

### N022 [Usability]: The product shall use symbols and words that are naturally understandable by users familiar with websites

### N023 [Usability]: The website will use standard Internet conventions when interacting with the user.

### N024 [Performance]: Any interface between a user and the automated system shall have a maximum response time of 5 seconds  unless noted by an exception below.

### N025 [Performance]: When purchasing a streaming movie or pre-paid card via credit card  the processing time should have a maximum response time of 15 seconds.

### N026 [Performance]: When streaming a movie  the buffering time should take no longer than 10 seconds (plus any latency on the users connection.)

### N027 [Performance]: While streaming a movie  buffering should only occur if there is latency in the users connection.

### N028 [Security]: All credit card information will be secured on the server  and only accessible by authorized Izogn administrators.  Information will be encrypted in the database.

### N029 [Availability]: The website shall be available for use 24 hours per day  365 days per year.

### N030 [Availability]: The website shall achieve 99.5% up time.

### N031 [Availability]: All movies shall be streamed on demand  at any time of the day.

### N032 [Fault Tolerance]: The website shall continue to operate if the streaming server goes down.

### N033 [Fault Tolerance]: The website shall continue to operate if the payment gateway goes down.

### N034 [Scalability]: The streaming server will support 50 simultaneous streaming connections.

### N035 [Scalability]: The streaming server will support a maximum of 700 movies; new servers can be added to support more movies.

### N036 [Scalability]: The server will support a maximum of 1 000 simultaneous users.

### N037 [Scalability]: The website shall be capable of supporting 100 000 customers.

### N038 [Maintainability]: The product shall be expected to operate within the maximum maintenance budget for a minimum of 2 years.

### N039 [Operational]: All aspects of the website shall be accessed by a web browser over the Internet.

### N040 [Operational]: The same hardware supporting the current website will be used to support the new system.

### N041 [Operational]: We must be able to interface with the following browsers: IE 5.X  6.0  Netscape 6.x  7.x  8.x and Firefox 1.0.

### N042 [Operational]: Website must interface with the CyberSource API to process credit card transactions.

### N043 [Operational]: Website must be fully operational with MSN TV2.

### N044 [Operational]: Movies shall be encoded and streamed via Windows Media Player 9.0.

### N045 [Operational]: Movies shall be encoded for 56k and 256k streams.

### N046 [Maintainability]: Promotional updates to the website should take a day to update.

### N047 [Performance]: Izogn Administrator must be able to update the category listings on the website within 2 minutes.

### N048 [Performance]: Izogn Administrator must be able to add new products to the website within 2 minutes.

### N049 [Availability]: The system will provide a 24 hour 800 toll free number for support to its customers.

### N050 [Usability]: The website will provide a help section with answers and solutions to common problems.

### N051 [Availability]: Velkat staff will be available for phone support between 7am-7pm  M-F to provide technical support to the Izogn administrators.

### N052 [Operational]: The product shall be able to be installed in the specified environment within 1 working day.

### N053 [Security]: Only registered customers can purchase streaming movies.

### N054 [Security]: A customer can only stream a movie if they purchased it  and are within the 2 day viewing period.

### N055 [Security]: Only authorized personnel can access customer records in the database.

### N056 [Security]: Only administrators can activate a pre-paid card.

### N057 [Security]: Only authorized personnel can access sales information.

### N058 [Security]: The website shall prevent its data from being corrupted when incorrect data is entered in.

### N059 [Security]: The website shall protect itself from intentional abuse  and notify the administrator at all occurrences.

### N060 [Security]: Data integrity scripts will be run on a weekly basis to verify the integrity of the database.

### N061 [Security]: The website shall make its user aware of its information practices before collection data from them via a Privacy Policy  accessible on all pages of the website.

### N062 [Security]: The system shall notify customers of changes to its information policy.

### N063 [Security]: The system shall reveal private information only in compliance with the organizations information policy.

### N064 [Security]: All customer information will be stored on a secure database  accessible only to authorized personnel.

### N065 [Security]: All credit card information will be encrypted in the database.

### N066 [Security]: The streaming server will have anti-virus software to prevent infection of malicious viruses.

### N067 [Look & Feel]: The website should cater to all tribes in Nigeria.

### N068 [Look & Feel]: The website shall not be offensive to religious or ethnic groups.

### N069 [Look & Feel]: The website should appeal to all Africans  not only Nigerians.

### N070 [Operational]: The website should use Flash to provide animation on the home page.

### N071 [Legal]: IzognMovies shall meet the licensing requirements set forth by the appropriate organizations in order to stream African movies.

### N072 [Legal]: The website will comply with W3C standards.

### N073 [Legal]: The PHP code will comply with PEAR standards.
