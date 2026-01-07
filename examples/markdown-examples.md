# Mermaid Diagram Examples in Markdown

This file demonstrates various Mermaid diagram types embedded in a Markdown document.

## Flowchart Example

```mermaid
flowchart LR
    A[Start] --> B{Decision}
    B -->|Yes| C[Action 1]
    B -->|No| D[Action 2]
    C --> E[End]
    D --> E
```

## Sequence Diagram Example

```mermaid
sequenceDiagram
    Alice->>John: Hello John, how are you?
    John-->>Alice: Great!
    Alice-)John: See you later!
```

## Class Diagram Example

```mermaid
classDiagram
    class Vehicle {
        +String model
        +int year
        +start()
        +stop()
    }

    class Car {
        +int doors
        +drive()
    }

    Vehicle <|-- Car
```

## State Diagram Example

```mermaid
stateDiagram-v2
    [*] --> Still
    Still --> [*]
    Still --> Moving
    Moving --> Still
    Moving --> Crash
    Crash --> [*]
```

## Gantt Chart Example

```mermaid
gantt
    title Project Schedule
    dateFormat YYYY-MM-DD
    section Phase 1
        Task 1           :a1, 2024-01-01, 30d
        Task 2           :after a1, 20d
    section Phase 2
        Task 3           :2024-02-01, 12d
        Task 4           :24d
```

## Entity Relationship Diagram

```mermaid
erDiagram
    USER ||--o{ ORDER : places
    USER {
        int id
        string name
        string email
    }
    ORDER {
        int id
        date order_date
        decimal total
    }
```

## Journey Diagram

```mermaid
journey
    title My working day
    section Go to work
      Make tea: 5: Me
      Go upstairs: 3: Me
      Do work: 1: Me, Cat
    section Go home
      Go downstairs: 5: Me
      Sit down: 5: Me
```

## Mindmap

```mermaid
mindmap
  root((Project))
    Planning
      Requirements
      Design
      Timeline
    Development
      Frontend
      Backend
      Database
    Testing
      Unit Tests
      Integration Tests
      E2E Tests
    Deployment
      CI/CD
      Monitoring
      Rollback Plan
```

## Timeline

```mermaid
timeline
    title History of Web Development
    2000 : HTML 4.01
         : CSS 2
    2008 : HTML5 draft
         : CSS3 modules
    2014 : HTML5 recommendation
    2022 : Modern frameworks
         : Web3 emergence
```
