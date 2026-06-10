---
title: "TypeScript API Design Patterns 2026: Modern Architecture for Scalable Applications"
description: "Complete guide to TypeScript API design patterns in 2026. Learn repository patterns, dependency injection, and advanced error handling with real production examples."
pubDate: 2026-05-12
category: software-engineering
tags: [TypeScript, API Design, Software Architecture]
targetKeyword: "typescript api design patterns 2026"
---

Building robust TypeScript APIs requires more than just knowing the syntax. After shipping enterprise systems like QuickWMS—a full-stack warehouse management platform handling thousands of transactions daily—we've learned that TypeScript API design patterns 2026 demands a systematic approach to architecture, error handling, and maintainability.

Modern TypeScript APIs need to handle complex business logic, maintain type safety across layers, and scale gracefully. The patterns we'll cover have been battle-tested in production environments where downtime costs thousands per minute.

## The Foundation: Clean Architecture with TypeScript

### Repository Pattern with Generic Constraints

The repository pattern remains essential, but TypeScript's advanced type system lets us build more robust abstractions. Here's how we structure our data layer:

```typescript
// Base repository interface with generic constraints
interface BaseEntity {
  id: string;
  createdAt: Date;
  updatedAt: Date;
}

interface IRepository<T extends BaseEntity> {
  findById(id: string): Promise<T | null>;
  create(data: Omit<T, 'id' | 'createdAt' | 'updatedAt'>): Promise<T>;
  update(id: string, data: Partial<T>): Promise<T>;
  delete(id: string): Promise<void>;
  findMany(filters?: Partial<T>): Promise<T[]>;
}

// Concrete implementation
class PostgresRepository<T extends BaseEntity> implements IRepository<T> {
  constructor(
    private db: Database,
    private tableName: string,
    private entityClass: new (...args: any[]) => T
  ) {}

  async findById(id: string): Promise<T | null> {
    const row = await this.db.query(
      `SELECT * FROM ${this.tableName} WHERE id = $1`,
      [id]
    );
    return row ? new this.entityClass(row) : null;
  }

  // Additional methods...
}
```

### Service Layer with Dependency Injection

We use a container-based approach for dependency injection, making services testable and loosely coupled:

```typescript
// Service interfaces
interface IUserService {
  createUser(data: CreateUserDto): Promise<User>;
  getUserById(id: string): Promise<User>;
}

interface INotificationService {
  sendWelcomeEmail(user: User): Promise<void>;
}

// Concrete service implementation
@Injectable()
class UserService implements IUserService {
  constructor(
    private userRepository: IRepository<User>,
    private notificationService: INotificationService
  ) {}

  async createUser(data: CreateUserDto): Promise<User> {
    const user = await this.userRepository.create(data);
    await this.notificationService.sendWelcomeEmail(user);
    return user;
  }

  async getUserById(id: string): Promise<User> {
    const user = await this.userRepository.findById(id);
    if (!user) {
      throw new NotFoundError(`User with id ${id} not found`);
    }
    return user;
  }
}
```

### Container Setup

```typescript
// DI container configuration
const container = new Container();

container.bind<IRepository<User>>('UserRepository')
  .to(PostgresRepository<User>)
  .inSingletonScope();

container.bind<IUserService>('UserService')
  .to(UserService)
  .inSingletonScope();

// Usage in controllers
@Controller('/users')
class UserController {
  constructor(
    @inject('UserService') private userService: IUserService
  ) {}
}
```

## Advanced Error Handling Patterns

### Result Pattern for Explicit Error Handling

Instead of throwing exceptions everywhere, we use a Result pattern that makes error handling explicit and type-safe:

```typescript
type Result<T, E = Error> = 
  | { success: true; data: T }
  | { success: false; error: E };

class UserService {
  async createUser(data: CreateUserDto): Promise<Result<User, ValidationError | DatabaseError>> {
    // Validate input
    const validation = this.validateUserData(data);
    if (!validation.success) {
      return { success: false, error: validation.error };
    }

    // Attempt database operation
    try {
      const user = await this.userRepository.create(data);
      return { success: true, data: user };
    } catch (error) {
      return { success: false, error: new DatabaseError('Failed to create user') };
    }
  }
}

// Controller usage
@Post('/users')
async createUser(@Body() data: CreateUserDto) {
  const result = await this.userService.createUser(data);
  
  if (!result.success) {
    if (result.error instanceof ValidationError) {
      return { status: 400, message: result.error.message };
    }
    return { status: 500, message: 'Internal server error' };
  }
  
  return { status: 201, data: result.data };
}
```

### Custom Error Classes with Context

We define specific error types that carry relevant context:

```typescript
abstract class AppError extends Error {
  abstract readonly statusCode: number;
  abstract readonly isOperational: boolean;

  constructor(message: string, public readonly context?: Record<string, any>) {
    super(message);
    this.name = this.constructor.name;
  }
}

class ValidationError extends AppError {
  readonly statusCode = 400;
  readonly isOperational = true;

  constructor(message: string, public readonly field: string, context?: Record<string, any>) {
    super(message, context);
  }
}

class NotFoundError extends AppError {
  readonly statusCode = 404;
  readonly isOperational = true;
}

class DatabaseError extends AppError {
  readonly statusCode = 500;
  readonly isOperational = true;
}
```

## Type-Safe Request/Response Patterns

### Branded Types for Domain Safety

We use branded types to prevent mixing up similar primitive values:

```typescript
// Branded types
type UserId = string & { readonly brand: unique symbol };
type OrderId = string & { readonly brand: unique symbol };
type ProductId = string & { readonly brand: unique symbol };

// Type guards
function isUserId(value: string): value is UserId {
  return /^user_[a-z0-9]+$/.test(value);
}

function isOrderId(value: string): value is OrderId {
  return /^order_[a-z0-9]+$/.test(value);
}

// Usage in service methods
class OrderService {
  async getOrder(orderId: OrderId, userId: UserId): Promise<Order> {
    // TypeScript ensures we can't accidentally mix up IDs
    return this.orderRepository.findByUserAndOrder(userId, orderId);
  }
}
```

### Strict DTO Validation with Zod

We use Zod for runtime validation that integrates seamlessly with TypeScript:

```typescript
import { z } from 'zod';

const CreateUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2).max(100),
  age: z.number().min(18).max(120),
  role: z.enum(['admin', 'user', 'moderator']),
});

type CreateUserDto = z.infer<typeof CreateUserSchema>;

// Validation middleware
function validateBody<T>(schema: z.ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: result.error.format(),
      });
    }
    req.body = result.data;
    next();
  };
}

// Controller usage
@Post('/users')
@Use(validateBody(CreateUserSchema))
async createUser(@Body() data: CreateUserDto) {
  // data is fully typed and validated
}
```

## Event-Driven Architecture Patterns

### Type-Safe Event System

For complex applications like our QuickWMS, we implement an event-driven architecture with full type safety:

```typescript
// Event definitions
interface DomainEvent {
  type: string;
  aggregateId: string;
  timestamp: Date;
  version: number;
}

interface UserCreatedEvent extends DomainEvent {
  type: 'user.created';
  payload: {
    userId: UserId;
    email: string;
    name: string;
  };
}

interface OrderShippedEvent extends DomainEvent {
  type: 'order.shipped';
  payload: {
    orderId: OrderId;
    userId: UserId;
    trackingNumber: string;
  };
}

type AppEvent = UserCreatedEvent | OrderShippedEvent;

// Event bus with type safety
class EventBus {
  private handlers = new Map<string, Array<(event: any) => Promise<void>>>();

  subscribe<T extends AppEvent>(
    eventType: T['type'],
    handler: (event: T) => Promise<void>
  ) {
    const handlers = this.handlers.get(eventType) || [];
    handlers.push(handler);
    this.handlers.set(eventType, handlers);
  }

  async publish<T extends AppEvent>(event: T): Promise<void> {
    const handlers = this.handlers.get(event.type) || [];
    await Promise.all(handlers.map(handler => handler(event)));
  }
}
```

### Event Handlers with Proper Error Isolation

```typescript
// Event handler with error isolation
class UserEventHandler {
  constructor(
    private notificationService: INotificationService,
    private analyticsService: IAnalyticsService
  ) {}

  @EventHandler('user.created')
  async handleUserCreated(event: UserCreatedEvent): Promise<void> {
    try {
      await this.notificationService.sendWelcomeEmail(event.payload);
    } catch (error) {
      // Log but don't fail other handlers
      console.error('Failed to send welcome email', error);
    }

    try {
      await this.analyticsService.trackUserRegistration(event.payload);
    } catch (error) {
      console.error('Failed to track user registration', error);
    }
  }
}
```

## Performance and Caching Patterns

### Typed Redis Caching Layer

We implement a type-safe caching layer using Redis:

```typescript
interface CacheOptions {
  ttl?: number;
  serialize?: boolean;
}

class TypedCache {
  constructor(private redis: Redis) {}

  async get<T>(key: string, parser: (data: string) => T): Promise<T | null> {
    const data = await this.redis.get(key);
    if (!data) return null;
    
    try {
      return parser(data);
    } catch (error) {
      console.warn(`Failed to parse cached data for key ${key}`, error);
      await this.redis.del(key); // Remove corrupted cache
      return null;
    }
  }

  async set<T>(
    key: string,
    value: T,
    serializer: (data: T) => string,
    options: CacheOptions = {}
  ): Promise<void> {
    const serialized = serializer(value);
    if (options.ttl) {
      await this.redis.setex(key, options.ttl, serialized);
    } else {
      await this.redis.set(key, serialized);
    }
  }
}

// Usage in service
class UserService {
  constructor(private cache: TypedCache) {}

  async getUserById(id: UserId): Promise<User | null> {
    // Try cache first
    const cached = await this.cache.get(
      `user:${id}`,
      (data) => JSON.parse(data) as User
    );
    
    if (cached) return cached;

    // Fetch from database
    const user = await this.userRepository.findById(id);
    if (user) {
      await this.cache.set(
        `user:${id}`,
        user,
        (data) => JSON.stringify(data),
        { ttl: 300 } // 5 minutes
      );
    }

    return user;
  }
}
```

## Database Integration Patterns

### Type-Safe Query Builder

Instead of raw SQL, we use a type-safe query builder approach:

```typescript
class QueryBuilder<T> {
  private conditions: Array<(entity: T) => boolean> = [];
  private sortField?: keyof T;
  private sortDirection: 'asc' | 'desc' = 'asc';

  where<K extends keyof T>(field: K, operator: 'eq' | 'gt' | 'lt', value: T[K]): this {
    this.conditions.push((entity) => {
      switch (operator) {
        case 'eq': return entity[field] === value;
        case 'gt': return entity[field] > value;
        case 'lt': return entity[field] < value;
      }
    });
    return this;
  }

  orderBy<K extends keyof T>(field: K, direction: 'asc' | 'desc' = 'asc'): this {
    this.sortField = field;
    this.sortDirection = direction;
    return this;
  }

  async execute(): Promise<T[]> {
    // Convert to actual SQL query
    // Implementation depends on your database layer
  }
}

// Usage
const users = await new QueryBuilder<User>()
  .where('status', 'eq', 'active')
  .where('age', 'gt', 18)
  .orderBy('createdAt', 'desc')
  .execute();
```

## Testing Patterns

### Repository Testing with Type Safety

We create mock repositories that maintain type safety:

```typescript
class MockUserRepository implements IRepository<User> {
  private users: Map<string, User> = new Map();

  async findById(id: string): Promise<User | null> {
    return this.users.get(id) || null;
  }

  async create(data: Omit<User, 'id' | 'createdAt' | 'updatedAt'>): Promise<User> {
    const user = new User({
      ...data,
      id: `user_${Math.random().toString(36)}`,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    this.users.set(user.id, user);
    return user;
  }

  // Seed method for testing
  seed(users: User[]): void {
    users.forEach(user => this.users.set(user.id, user));
  }
}

// Test setup
describe('UserService', () => {
  let userService: UserService;
  let mockRepository: MockUserRepository;

  beforeEach(() => {
    mockRepository = new MockUserRepository();
    userService = new UserService(mockRepository, mockNotificationService);
  });

  it('should create user successfully', async () => {
    const userData = {
      email: 'test@example.com',
      name: 'Test User',
      age: 25,
    };

    const result = await userService.createUser(userData);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBe(userData.email);
    }
  });
});
```

## Integration with AI Services

When building AI-powered features like we did with Vidmation, proper TypeScript patterns become crucial for handling external AI APIs. Here's how we structure AI service integration:

```typescript
interface AIServiceResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  usage?: {
    tokens: number;
    cost: number;
  };
}

class ClaudeAPIService {
  constructor(private apiKey: string) {}

  async generateContent(prompt: string): Promise<AIServiceResponse<string>> {
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
