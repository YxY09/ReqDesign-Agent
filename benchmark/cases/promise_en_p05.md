# PROMISE NFR (English) — Project 5

## Functional Requirements

### F001: The user shall search for the preferred repair facility using vehicle  vehicle location  and radius in miles

### F002: The vehicle data shall include vehicle year  make  and model

### F003: The vehicle location shall include street address  city  state  and zipcode

### F004: The system shall resolve the zipcode for the street address  city  and state if zipcode is unknown.

### F005: The search radius shall be between 1 and 30 miles

### F006: The system shall locate the preferred repair facility with the highest ratings for the input criteria

### F007: The adjuster shall enter the preferred repair facility on the estimate assignment.

### F008: The adjuster shall be able to override the preferred repair facitlity on the estimate assignment.

### F009: The preferred repair facility shall be returned to the user.

### F010: The system shall return a list of repair facilities within the radius if the preferred repair facility cannot be determined.

### F011: The estimator shall search for available recycled parts using damaged vehicle parts information.

### F012: The estimator shall search for available recycled parts using a list of preferred parts suppliers.

### F013: The system shall search for available recycled parts for the supplied vehicle parts and suppliers.

### F014: The estimator shall search by zipcode with a radius of 30 miles if no parts are found for the preferred parts suppliers

### F015: The system shall retain the available recycled parts and suppliers returned from the search.

### F016: The available recycled parts information and their suppliers shall be returned to the user.

### F017: The estimator shall apply selected recycled parts to the collision estimate.

### F018: The estimator shall not apply recycled parts to the collision estimate if no available parts are returned.

### F019: The adjuster shall review the collision estimate.

### F020: The adjuster shall request a recycled parts audit of the collision estimate.

### F021: The recycled parts search results provided to the estimator shall be retrieved by the system.

### F022: The system shall generate an audit report based on the available recycled parts and the collision estimate.

### F023: The audit report shall include the total number of recycled parts used in the estimate.

### F024: The audit report shall include the number of available recycled parts from the original search results.

### F025: The audit report shall include the percentage of available recycled parts used in the estimate

### F026: The audit report shall include the total score of the audit which sums the indivual line items.

### F027: The audit report shall be displayed to the user.

### F028: The audit report shall be available to other adjusters at later points in time.

### F029: The user shall select to view the preferred repair facility ratings.

### F030: The current repair facility ratings shall be displayed to the user.

### F031: The system will display a blank set of ratings if there are not ratings yet defined.

### F032: The user shall enter new ratings based on the audit report

### F033: The ratings shall be from a scale of 1-10

### F034: The ratings shall include categories for attempted use of recycled parts and actual use of recycled parts

### F035: The user shall select to save the preferred repair facility ratings.

### F036: The preferred repair facility ratings shall be saved by the system.

## Non-Functional Requirements

### N001 [Operational]: The product must support Internet Explorer 5.5 and above.

### N002 [Operational]: The product must support Mozilla Firefox 1.0 and above.

### N003 [Operational]: The product shall interface with the Choice Parts System.  This provides the feed of recycled parts data.

### N004 [Operational]: The product shall run on the existing hardware for all environments.

### N005 [Operational]: The product shall adhere to the corporate Architecture guidelines

### N006 [Look & Feel]: The product shall comply with corporate User Interface Guidelines

### N007 [Look & Feel]: The product shall comply with corporate color scheme

### N008 [Look & Feel]: The appearance of the product shall appear professional

### N009 [Usability]: The product shall be easy to use by Adjusters and Collision Estimators.  95% of Adjusters and Collision Estimators shall find the product easy to use.

### N010 [Usability]: The product shall increase productivity of Collision Estimators. 80% of the Collision Estimators shall agree their productivity has increase within 1 month of using the product.

### N011 [Usability]: Users shall feel satisfied using the product.  85% of all users will be satisfied with the product.

### N012 [Usability]: The product shall be easy to learn by Adjusters and Collision Estimators.  The product shall be learned with two days onsite training

### N013 [Usability]: The user shall easily locate instructions while using the product.  User help can be found within 90% of the system.

### N014 [Performance]: The search for recycled parts shall take no longer than 15 seconds.  The search results shall be returned in under 15 seconds.

### N015 [Performance]: The search for the preferred repair facility shall take no longer than 8 seconds.  The preferred repair facility is returned within 8 seconds

### N016 [Performance]: The recycled parts audit report shall be returned to the user within 10 seconds.  The audit report shall be returned within 10 seconds.

### N017 [Performance]: The preferred repair facility ratings shall be saved within 5 seconds. The save shall occur within 5 seconds.

### N018 [Availability]: The product shall adhere to the corporate online availability schedule.  The application is brought down only within 98% of the scheduled outages per the availability schedule.

### N019 [Availability]: The product shall achieve a 98% uptime. The product shall not fail more than 2% of the available online time.

### N020 [Scalability]: The product shall be able to handle up to 1500 simultaneous users. The system shall perform with 1500 users as a time.

### N021 [Scalability]: The average number of recycled parts records per day shall be 50 000.

### N022 [Scalability]: The product shall be able to handle 10 000 concurrent users within 2 years of the initial launch.

### N023 [Operational]: For estimators  the product shall be able to be operated in a repair facility during dirty and noisy conditions.

### N024 [Operational]: The product shall interface with the ChoiceParts system once per day at approximately 1:00 AM.

### N025 [Operational]: The maintenance of the product will fall within the established corporate maintenance windows.

### N026 [Operational]: The product shall be supported using the corporate support center.

### N027 [Operational]: Product installations and upgrades shall be handled by the middleware technology team within established launch time frames.

### N028 [Security]: Only adjusters can request recycled parts audit reports. No users without an adjuster role shall request recycled parts audits.

### N029 [Security]: Only adjusters with a supervisor role can update preferred repair facility ratings. Users without the supervisor role cannot access the repair facility ratings.

### N030 [Security]: Only collision estimators shall search for recycled parts.  Users without the collision estimator role shall not have access to the search for recycled parts.

### N031 [Security]: Only valid data shall be entered into the system.  No invalid data shall be entered into the system.

### N032 [Security]: One insurance company shall not be able to view another insurance companys claim data.

### N033 [Security]: The product shall free of computer viruses.

### N034 [Security]: The system shall prevent malicious attacks including denial of service.

### N035 [Legal]: The product must comply with Sarbanes-Oxley.

### N036 [Legal]: The product shall comply with the estimatics laws relating to recycled parts usage.

### N037 [Legal]: The product shall comply with insurance regulations regarding claims processing.
