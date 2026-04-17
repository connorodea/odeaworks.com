---
title: "Full Stack TypeScript Project Structure: A Production-Ready Guide"
description: "Learn how to structure full stack TypeScript projects for scalability and maintainability with proven patterns from production applications."
pubDate: 2026-04-17
category: software-engineering
tags: [TypeScript, Full Stack, Project Structure, Software Architecture]
targetKeyword: "full stack typescript project structure"
---

A well-organized full stack TypeScript project structure is the foundation of maintainable, scalable applications. After building enterprise systems like QuickLotz WMS — a complex warehouse management platform handling millions in inventory transactions — we've learned that getting the structure right from day one saves countless hours of refactoring later.

The wrong structure leads to import hell, circular dependencies, and code that's impossible to navigate. The right structure creates clear boundaries, enables team collaboration, and scales from prototype to production.

## Why TypeScript for Full Stack Development?

TypeScript provides end-to-end type safety across your entire application stack. When your frontend components share type definitions with your backend API responses, you catch integration bugs at compile time instead of runtime. This is especially powerful for complex applications where data flows through multiple layers.

We've seen teams reduce API integration bugs by 80% simply by sharing TypeScript interfaces between frontend and backend. The initial setup investment pays dividends as your application grows.

## Monorepo vs Multi-Repo Approach

Before diving into structure, decide between monorepo and multi-repo architecture:

**Monorepo Benefits:**
- Shared TypeScript types between frontend and backend
- Atomic commits across the full stack
- Single CI/CD pipeline
- Easier dependency management

**Multi-Repo Benefits:**
- Independent deployment cycles
- Cleaner separation of concerns
- Different teams can own different repositories

For most full stack TypeScript projects, we recommend monorepo. The shared types alone justify the approach. Here's how we structure them:

## Core Directory Structure

```
my-app/
├── apps/
│   ├── api/                 # Backend API
│   └── web/                 # Frontend application
├── packages/
│   ├── shared/              # Shared types and utilities
│   ├── database/            # Database schema and migrations
│   └── config/              # Shared configuration
├── tools/
│   ├── scripts/             # Build and deployment scripts
│   └── docker/              # Docker configurations
├── docs/                    # Project documentation
├── package.json
├── turbo.json               # Turborepo configuration
└── tsconfig.json            # Root TypeScript config
```

This structure separates applications (`apps/`) from reusable packages (`packages/`), making dependencies explicit and enabling selective deployment.

## Backend API Structure

The backend API should follow domain-driven design principles while remaining simple enough for rapid development:

```
apps/api/
├── src/
│   ├── controllers/         # HTTP request handlers
│   │   ├── auth.controller.ts
│   │   ├── users.controller.ts
│   │   └── index.ts
│   ├── services/           # Business logic layer
│   │   ├── auth.service.ts
│   │   ├── users.service.ts
│   │   └── index.ts
│   ├── middleware/         # Express middleware
│   │   ├── auth.middleware.ts
│   │   ├── validation.middleware.ts
│   │   └── error.middleware.ts
│   ├── routes/            # Route definitions
│   │   ├── auth.routes.ts
│   │   ├── users.routes.ts
│   │   └── index.ts
│   ├── types/             # API-specific types
│   │   ├── request.types.ts
│   │   ├── response.types.ts
│   │   └── index.ts
│   ├── utils/             # Utility functions
│   │   ├── logger.ts
│   │   ├── validation.ts
│   │   └── index.ts
│   ├── config/            # Configuration management
│   │   ├── database.ts
│   │   ├── env.ts
│   │   └── index.ts
│   └── app.ts             # Express app setup
├── tests/                 # Test files
├── package.json
└── tsconfig.json
```

Here's a sample controller structure:

```typescript
// apps/api/src/controllers/users.controller.ts
import { Request, Response } from 'express';
import { UserService } from '../services/user.service';
import { CreateUserRequest, UserResponse } from '@myapp/shared';

export class UserController {
  constructor(private userService: UserService) {}

  async createUser(req: Request<{}, UserResponse, CreateUserRequest>, res: Response<UserResponse>) {
    try {
      const user = await this.userService.createUser(req.body);
      res.status(201).json({ data: user, success: true });
    } catch (error) {
      res.status(400).json({ error: error.message, success: false });
    }
  }

  async getUsers(req: Request, res: Response<UserResponse[]>) {
    const users = await this.userService.getUsers();
    res.json({ data: users, success: true });
  }
}
```

## Frontend Application Structure

For React applications, we organize by feature rather than file type. This scales better as teams grow:

```
apps/web/
├── src/
│   ├── components/         # Reusable UI components
│   │   ├── ui/            # Basic UI elements (Button, Input, etc.)
│   │   ├── layout/        # Layout components (Header, Sidebar)
│   │   └── forms/         # Form components
│   ├── features/          # Feature-based organization
│   │   ├── auth/
│   │   │   ├── components/
│   │   │   ├── hooks/
│   │   │   ├── services/
│   │   │   └── types/
│   │   ├── users/
│   │   │   ├── components/
│   │   │   ├── hooks/
│   │   │   ├── services/
│   │   │   └── types/
│   │   └── dashboard/
│   ├── hooks/             # Global custom hooks
│   ├── services/          # API clients and external services
│   ├── utils/             # Utility functions
│   ├── types/             # Frontend-specific types
│   ├── styles/            # Global styles
│   ├── config/            # Configuration
│   └── App.tsx
├── public/
├── package.json
└── tsconfig.json
```

A typical feature might look like this:

```typescript
// apps/web/src/features/users/hooks/useUsers.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { userService } from '../services/userService';
import { CreateUserRequest } from '@myapp/shared';

export const useUsers = () => {
  return useQuery({
    queryKey: ['users'],
    queryFn: userService.getUsers,
  });
};

export const useCreateUser = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (userData: CreateUserRequest) => userService.createUser(userData),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });
};
```

## Shared Package Structure

The shared package contains types, utilities, and configurations used across applications:

```
packages/shared/
├── src/
│   ├── types/
│   │   ├── api/           # API request/response types
│   │   ├── entities/      # Domain entities
│   │   └── common/        # Common utility types
│   ├── utils/
│   │   ├── validation/    # Shared validation schemas
│   │   ├── constants/     # Application constants
│   │   └── helpers/       # Helper functions
│   ├── config/
│   │   ├── database.ts    # Database configuration types
│   │   └── app.ts         # Application configuration
│   └── index.ts           # Main exports
├── package.json
└── tsconfig.json
```

Example shared types:

```typescript
// packages/shared/src/types/entities/user.ts
export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  createdAt: Date;
  updatedAt: Date;
}

export enum UserRole {
  ADMIN = 'admin',
  USER = 'user',
  MODERATOR = 'moderator'
}

// packages/shared/src/types/api/user.ts
export interface CreateUserRequest {
  email: string;
  name: string;
  password: string;
}

export interface UserResponse {
  data: User;
  success: boolean;
  error?: string;
}
```

## Database Package Structure

Keep database-related code in a separate package for better organization:

```
packages/database/
├── src/
│   ├── entities/          # Database entities (if using TypeORM)
│   ├── migrations/        # Database migrations
│   ├── seeds/             # Seed data
│   ├── schemas/           # Database schemas
│   └── connection.ts      # Database connection setup
├── package.json
└── tsconfig.json
```

## TypeScript Configuration Strategy

Use a cascading TypeScript configuration with a root `tsconfig.json` and specific configs for each package:

```json
// Root tsconfig.json
{
  "compilerOptions": {
    "target": "ES2020",
    "lib": ["ES2020"],
    "module": "commonjs",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "outDir": "dist"
  },
  "include": ["apps/**/*", "packages/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

```json
// apps/api/tsconfig.json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "types": ["node"]
  },
  "include": ["src/**/*"],
  "references": [
    { "path": "../../packages/shared" },
    { "path": "../../packages/database" }
  ]
}
```

## Build and Development Workflow

Use Turborepo for efficient monorepo builds and development:

```json
// turbo.json
{
  "$schema": "https://turbo.build/schema.json",
  "pipeline": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "dev": {
      "cache": false
    },
    "lint": {},
    "test": {
      "dependsOn": ["^build"]
    }
  }
}
```

Package.json scripts:

```json
{
  "scripts": {
    "dev": "turbo run dev",
    "build": "turbo run build",
    "test": "turbo run test",
    "lint": "turbo run lint",
    "dev:api": "turbo run dev --filter=api",
    "dev:web": "turbo run dev --filter=web"
  }
}
```

## Environment Configuration

Manage environment variables consistently across applications:

```typescript
// packages/config/src/env.ts
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().transform(Number).default(3000),
  DATABASE_URL: z.string(),
  JWT_SECRET: z.string(),
  API_URL: z.string().url(),
});

export const env = envSchema.parse(process.env);
export type Env = z.infer<typeof envSchema>;
```

## Testing Strategy

Organize tests to mirror your application structure:

```
apps/api/tests/
├── unit/
│   ├── services/
│   └── utils/
├── integration/
│   ├── controllers/
│   └── routes/
└── fixtures/

apps/web/tests/
├── components/
├── features/
├── hooks/
└── utils/
```

Use Jest with different configurations for frontend and backend testing needs.

## Deployment Considerations

Structure your deployment scripts and Docker configurations in the tools directory:

```
tools/
├── docker/
│   ├── Dockerfile.api
│   ├── Dockerfile.web
│   └── docker-compose.yml
├── scripts/
│   ├── build.sh
│   ├── deploy.sh
│   └── migrate.sh
└── ci/
    └── github-workflows/
```

This organization makes it easy to deploy different parts of your application independently or together, depending on your needs.

## Real-World Application: QuickLotz WMS

When we built QuickLotz WMS, this exact full stack TypeScript project structure enabled us to:

- Share inventory item types between the React dashboard and Node.js API
- Deploy the API and frontend independently for different release cycles
- Onboard new developers quickly with clear separation of concerns
- Scale to handle millions of inventory transactions without architectural refactoring

The key was establishing these patterns early. As we added features like real-time inventory tracking, automated receiving workflows, and complex reporting dashboards, the structure supported rapid development without technical debt accumulation.

For more insights on related topics, check out our guide on [warehouse management system custom development](/blog/2026-04-16-warehouse-management-system-custom-development) and [automating business workflows with Python](/blog/2026-04-14-automating-business-workflows-with-python).

## Key Takeaways

- Use monorepo structure for shared TypeScript types and atomic deployments
- Organize by feature, not file type, for better scalability
- Create a separate shared package for types and utilities used across applications
- Implement cascading TypeScript configurations for consistent builds
- Use Turborepo for efficient build and development workflows
- Structure tests to mirror your application organization
- Establish these patterns early — refactoring later is expensive

A well-planned full stack TypeScript project structure pays dividends throughout your application's lifecycle. It reduces bugs, accelerates development, and makes onboarding new team members straightforward.

If you're building a complex full stack TypeScript application and want to get the architecture right from the start, we'd love to help. [Reach out](/contact) to discuss your project.
