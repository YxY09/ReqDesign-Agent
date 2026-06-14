# PROMISE NFR (English) — Project 4

## Functional Requirements

### F001: The Disputes System must be accessible by both internal and external users.

### F002: The Disputes System must prevent users from accessing any dispute cases that do not belong to their cardholder base.

### F003: The Disputes System will facilitate direct data entry of a dispute case via a user interface that supports real time responses to the users.

### F004: The Disputes System must provide different levels of access with regard to disputes case initiation and follow-up actions.

### F005: The Disputes System shall provide view access capability for authorized users of the application.

### F006: The Disputes System shall provide update access capability for authorized users of the application.

### F007: The Disputes System must allow the users to select disputable transactions (based on the age of the transaction) from a user interface and initiate a dispute (ticket retrieval request or chargeback notification) on the selected transaction.

### F008: The Disputes System must provide the user the ability to initiate a single dispute case on multiple transactions that belong to a single merchant.

### F009: The Disputes System will provide the user the ability to create or initiate a ticket retrieval request.   As part of ticket retrieval creation process the system must prompt the user to enter all the required information to create the ticket retrieval request.  The ticket retrieval request is a document that is sent to merchant inquiring the validity of a transaction.

### F010: The Disputes System must allow the user to create three unique types of ticket retrieval requests.  The three types of ticket retrieval requests are (1) Request for original receipt (2) Request for a copy of the receipt or (3) Request for a portfolio. A portfolio consists of documentation that would provide proof of a purchase such as the documentation that is received from a car rental agency that is more than a sales receipt.

### F011: The Disputes System must prevent external users from requesting original receipts. Requests for original receipts are restricted to internal users.

### F012: The Disputes System must provide a confirmation to the user upon the creation of ticket retrieval request that contains the following information; the dispute case number  the type of retrieval requested (copy  original or portfolio)  and the date that the merchant response is due.

### F013: The Disputes System shall allow the user to create or initiate a chargeback request.  The system must prompt the user to enter the required information to initiate a chargeback request. The chargeback request results in a printed chargeback notification that is sent to merchant indicating that their account will be charged back if no proof is provided that the disputed transaction is valid.

### F014: The Disputes System must provide a confirmation to the user upon the creation of a chargeback request. The confirmation must contain the following information; the dispute case number  the type of chargeback requested (pending or immediate)  and the date that the merchant response is due.

### F015: The Disputes System shall prevent the creation of duplicate dispute requests 100% of the time.

### F016: The Disputes System shall accurately provide a list of possible reason codes for a given transaction.  The list of possible reason codes must be derived based on the type of transaction and the industry that the merchant belongs to  according to the business rules defined for the Disputes System.

### F017: The Disputes System must provide the ability to view existing dispute cases.

### F018: The Disputes System must provide Search functionality.  The search method must include the ability to search by (1) the dispute case number  (2) the merchant account number  (3) the cardmember account number and (4) the issuer number.  In addition to the above criteria  the search functionality must further allow the user to limit the results of the search by a date range  the type of dispute (ticket retrieval request or chargeback notification)  the case status (open  closed or all) and the dispute reason code.

### F019: A list of all disputes cases that meet the entered search criteria must be provided to the user.  The list of cases must differentiate the type and/or status of the case by color -coding the line item in the list.  For example all open cases will be yellow and all closed cases will be gray.

### F020: The Disputes System shall provide the users the ability to view the history of all activities that have occurred on the dispute case.

### F021: The Dispute System shall provide the users with the ability to follow up on a dispute case via follow-up actions.  The list of available follow up actions for a given dispute case must be filtered by the status of the case and the access level of the user.

### F022: The Disputes System shall record the name of the user and the date for any activity that creates or modifies the disputes case in the system.  A detailed history of the actions taken on the case  including the date and the user that performed the action must be maintained for auditing purposes.

### F023: For any systematic (non-user initiated) action that occurs on a case such as the disputes aging process  a case activity will be generated.  Upon the next logon the user that initiated the dispute case must be notified that a systematic action has occurred on the dispute case.

### F024: All letter requests must be formatted according to guidelines specified by the Print Letter Utility system.

### F025: Any disputes cases that have been closed for over 6 months must be purged from the online disputes database.

## Non-Functional Requirements

### N001 [Look & Feel]: The Disputes application shall comply with the corporate standards for user interface creation for internally and externally used applications.

### N002 [Look & Feel]: All screens created as part of the Disputes application must comply with corporate standards for interface creation.

### N003 [Usability]: The list of dispute cases that are displayed after a search is performed must be color coded for easy identification of dispute cases based upon the dispute case status.

### N004 [Usability]: 100% of the cardmember and merchant services representatives shall use the Disputes application regularly after a 2-day training course.

### N005 [Usability]: 100% of cardmember services representatives shall be able to successfully create a dispute case on the first encounter after completing the training course.

### N006 [Usability]: 100% of merchant services representatives shall be able to successfully perform a follow up action on a dispute case on the first encounter after completing the training course.

### N007 [Performance]: The maximum wait time for a user navigating from one screen to another within the Disputes application shall be no more than 5 seconds.

### N008 [Performance]: The Disputes application shall support 350 concurrent users without any degradation of performance in the application.

### N009 [Operational]: The Disputes application shall be available 24x7x365  with the exception of the following scheduled maintenance windows.  Monday  Saturday 3:00am to 4:00am EST Sunday 1:00amd to 5:00am EST

### N010 [Operational]: The Disputes application shall interface with the Statement Database. The Statement Database provides the transaction details to the Disputes System. All transaction details must be obtained from the Statement Database

### N011 [Operational]: The Disputes application shall interface with the Cardmember Information Database.  The Cardmember Information Database provides detailed information with regard to a cardmember.  All cardmember detail information must be obtained from the Cardmember Information Database.

### N012 [Operational]: The Disputes applications shall interface with the Merchant Information Database.  The Merchant Information Database provides detailed information with regard to the merchant. All merchant detail information shall be obtained from the Merchant Information Database.

### N013 [Operational]: The Disputes application shall interface with the Letters application.  This will allow the Disputes application to request letters as part of the dispute initiation and dispute follow up process. All letter requests must be sent to the Print Letter Utility application.

### N014 [Operational]: The Disputes application shall interface with the Cardmember Posting and Billing System.  This will allow the Disputes application to request adjustments to cardmember and merchants accounts. All adjustment requests must be sent to the Cardmember Posting and Billing System.

### N015 [Security]: The Disputes application shall ensure that only users with the appropriate access level are allowed to initiate dispute requests.

### N016 [Security]: Only users with Update access must be able to initiate dispute requests.

### N017 [Security]: The Disputes application shall ensure that only authorized users are allowed to logon to the application.

### N018 [Security]: All authorized users  once authenticated must be able to logon to the Disputes System

### N019 [Security]: The Disputes System shall generate a User Report that details any new users that have been added and any changes to an existing users access level.  The report will be reviewed for auditing purposes.

### N020 [Security]: All additions of new users and modifications to users access shall be recorded on the User Report.

### N021 [Security]: If a user account is revoked  it can only be re-instantiated by the System Administrator.

### N022 [Security]: Only the System Administrator shall be able to reset a revoked user logon account

### N023 [Security]: The Disputes application shall manipulate and view business data. Users will not have direct access to data files or databases.

### N024 [Security]: All updates to data files or database must be initiated from the Disputes System.

### N025 [Legal]: The Disputes application must conform to the legal requirements as specified by the Merchant Operating Regulations.

### N026 [Legal]: All business rules specified in the Disputes System shall be in compliance with the Merchant Operating Regulations.

### N027 [Legal]: The Disputes application must conform to the legal requirements as specified by Regulation E and Regulation Z that govern credit card disputes processing.

### N028 [Legal]: All business rules specified in the Disputes System shall be in compliance to the guidelines of Regulation E and Regulation Z.

### N029 [Legal]: The Disputes application must maintain a detailed history of every action that a user takes on a dispute case.  This ensures a complete audit trail if questions arise later on with regard to a particular dispute case.

### N030 [Legal]: All actions that modify an existing dispute case must be recorded in the case history.
