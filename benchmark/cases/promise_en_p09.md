# PROMISE NFR (English) — Project 9

## Functional Requirements

### F001: The vendor will verify the invalid lead.

### F002: Vendor will submit a credit validation record to be applied to the enterprise billing system.

### F003: If a lead is scored to the high range the system will supply the lead data and score to the enterprise system.

### F004: The leads washing functionality will validate all leads received by the web service for valid data

### F005: The leads washing functionality will insert all leads captured by the web service.

### F006: If the leads score falls within the high average score then it will be process by the ARA functionality.

### F007: If the leads score falls within the medium average then it will be set for manual verification by an Enrollment Coordinator through the eleads system.

### F008: If the leads score falls within the low average then it will be returned to the supplying vendor

### F009: The leads washing functionality will compile both contact and academic scoring information for a total score.

### F010: The leads washing functionality will use the parameters supplied by corporate and schools to score part of the lead.

### F011: The leads washing functionality will return the lead data supplied to the vendor along with the reason of rejection.

### F012: The leads washing functionality will have an interface in which lead data parameters can be maintained.

### F013: The leads washing functionality will verify the users authentication and rights to make parameter updates.

### F014: The leads washing functionality will store any potential lead duplicates returned by the enterprise system.

### F015: Prior to submitting the lead to the enterprise system the leads washing functionality will assign the lead to an admissions rep.

### F016: The leads washing functionality shall receive a period list of available reps from the enterprise system.

## Non-Functional Requirements

### N001 [Performance]: Total lead cycle time must be completed in 5 minutes for 90% of lead volume between the business hours of 8AM CST to 8PM CST; then 3 minutes for 99% of lead volume during off business hours.

### N002 [Performance]: No lead evaluation will complete in a time period longer than 25 seconds for 97% of all leads processed.

### N003 [Performance]: For leads that process longer than 25 seconds the system will record the event and duration

### N004 [Performance]: The process must fit within the processing time conditions set forth by the Auto Rep Assignment process in which a lead is assigned within 3 minutes of the total life cycle.

### N005 [Operational]: The lead washing process will operate within the established physical web service structure.

### N006 [Operational]: The washing process must use a non binding  neutral data format  such as xml  when receiving and processing lead data.

### N007 [Availability]: Defect reports will be available to technical units on a 24x7 basis.

### N008 [Maintainability]: Washing parameters will be updated during scheduled maintenance hours.
