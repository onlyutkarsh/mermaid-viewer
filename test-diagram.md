# Mermaid Preview Test File

Test the extension with these sample diagrams!

## Flowchart Example

```mermaid
---
config:
  layout: elk
  elk:
    mergeEdges: false
    nodePlacementStrategy: LINEAR_SEGMENTS
---
erDiagram
    CUSTOMER ||--o{ ORDER : places
    ORDER ||--|{ LINE-ITEM : contains
    CUSTOMER {
        string name
        string email
        int id
    }
    ORDER {
        int orderNumber
        date orderDate
        int customerId
    }
    LINE-ITEM {
        int quantity
        decimal price
    }
```

```mermaid
graph TD
    A[Start] --> B{Is it working?}
    B -->|Yes| C[Awesome!]
    B -->|No| D[Debug it]
    D --> B
    C --> E[End]
```

## Sequence Diagram

```mermaid
sequenceDiagram
    participant User
    participant Extension
    participant Mermaid
    User->>Extension: Open Preview
    Extension->>Mermaid: Render Diagram
    Mermaid-->>Extension: SVG Output
    Extension-->>User: Display Preview
```

## Entity Relationship Diagram

```mermaid
erDiagram
    CUSTOMER ||--o{ ORDER : places
    ORDER ||--|{ LINE-ITEM : contains
    CUSTOMER {
        string name
        string email
        int id
    }
    ORDER {
        int orderNumber
        date orderDate
        int customerId
    }
    LINE-ITEM {
        int quantity
        decimal price
    }
```

## Class Diagram

```mermaid
classDiagram
    class Animal {
        +String name
        +int age
        +makeSound()
    }
    class Dog {
        +String breed
        +bark()
    }
    class Cat {
        +String color
        +meow()
    }
    Animal <|-- Dog
    Animal <|-- Cat
```

## State Diagram

```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> Processing: Start
    Processing --> Success: Complete
    Processing --> Failed: Error
    Success --> [*]
    Failed --> Idle: Retry
```

## Gantt Chart

```mermaid
gantt
    title Project Timeline
    dateFormat  YYYY-MM-DD
    section Planning
    Requirements :a1, 2024-01-01, 7d
    Design      :a2, after a1, 5d
    section Development
    Coding      :a3, after a2, 14d
    Testing     :a4, after a3, 7d
    section Deployment
    Release     :a5, after a4, 3d
```

## Instructions

1. Open this file in VSCode
2. Press `Cmd+Shift+P` (Mac) or `Ctrl+Shift+P` (Windows/Linux)
3. Type "Mermaid: Open Preview to the Side"
4. Try changing themes in the preview toolbar!
5. Edit any diagram and watch it update live!
