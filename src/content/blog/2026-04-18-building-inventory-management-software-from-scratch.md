---
title: "Building Inventory Management Software From Scratch: A Technical Case Study"
description: "Real-world case study of building enterprise inventory management software from scratch. Architecture decisions, challenges, and code examples."
pubDate: 2026-04-18
category: software-engineering
tags: [inventory-management, software-architecture, typescript, case-study]
targetKeyword: "building inventory management software from scratch"
---

Building inventory management software from scratch is one of the most complex enterprise software challenges you'll face. We learned this firsthand when we built QuickLotz WMS, a full-featured warehouse management system for a liquidation business handling millions in inventory.

When their existing system couldn't scale past 10,000 SKUs and manual processes were eating into profit margins, we had two choices: customize an existing WMS (expensive, limiting) or build from scratch. We chose to build from scratch, and over 18 months delivered a system that automated their entire warehouse operation.

Here's exactly how we approached building inventory management software from scratch, the technical decisions that mattered, and the code patterns that made it work.

## Why Build Inventory Management Software From Scratch?

Most businesses start with the "buy vs build" question. For QuickLotz, the math was clear:

**Existing solutions fell short:**
- NetSuite WMS: $2,000/month + customization costs
- Manhattan Associates: Six-figure implementation
- Fishbowl: Couldn't handle their liquidation workflow (random lot sizes, dynamic pricing)

**Custom requirements:**
- Liquidation-specific workflows (lot receiving, condition grading)
- Real-time pricing updates from auction platforms
- Custom reporting for cost accounting
- Integration with their existing ERP

The total cost of building from scratch was less than two years of licensing fees, with complete control over features and roadmap.

## Technical Architecture Decisions

### Stack Selection

We chose TypeScript across the full stack for QuickLotz WMS:

```typescript
// Backend: Node.js + Express + TypeScript
interface InventoryItem {
  id: string;
  sku: string;
  lotId: string;
  condition: 'new' | 'used' | 'refurbished' | 'damaged';
  location: LocationCode;
  quantity: number;
  reservedQuantity: number;
  lastUpdated: Date;
}

// Frontend: React + TypeScript
interface InventoryListProps {
  filters: InventoryFilters;
  onItemUpdate: (item: InventoryItem) => void;
}
```

**Why TypeScript everywhere?**
- Type safety prevents inventory quantity bugs
- Shared interfaces between frontend/backend
- Better IDE support for complex business logic
- Easier refactoring as requirements change

### Database Design

PostgreSQL with a hybrid normalized/denormalized approach:

```sql
-- Core inventory table (normalized)
CREATE TABLE inventory_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku VARCHAR(100) NOT NULL,
  lot_id UUID REFERENCES lots(id),
  condition inventory_condition NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity >= 0),
  reserved_quantity INTEGER DEFAULT 0 CHECK (reserved_quantity >= 0),
  location_code VARCHAR(20) REFERENCES locations(code),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Denormalized view for fast queries
CREATE MATERIALIZED VIEW inventory_summary AS
SELECT 
  i.sku,
  i.condition,
  SUM(i.quantity) as total_quantity,
  SUM(i.reserved_quantity) as total_reserved,
  COUNT(DISTINCT i.location_code) as location_count,
  MAX(i.updated_at) as last_movement
FROM inventory_items i
WHERE i.quantity > 0
GROUP BY i.sku, i.condition;

-- Refresh materialized view on inventory changes
CREATE OR REPLACE FUNCTION refresh_inventory_summary()
RETURNS TRIGGER AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY inventory_summary;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
```

This hybrid approach gave us ACID compliance for transactions while maintaining sub-100ms query performance on complex inventory reports.

## Core System Components

### 1. Inventory Transaction Engine

The heart of any inventory system is the transaction engine. Every inventory movement must be atomic and auditable:

```typescript
class InventoryTransactionEngine {
  async executeTransaction(transaction: InventoryTransaction): Promise<TransactionResult> {
    return await this.db.transaction(async (trx) => {
      // 1. Validate transaction
      const validation = await this.validateTransaction(transaction, trx);
      if (!validation.valid) {
        throw new Error(`Invalid transaction: ${validation.errors.join(', ')}`);
      }

      // 2. Lock inventory records
      const inventoryLocks = await this.lockInventoryItems(
        transaction.items.map(item => item.id), 
        trx
      );

      // 3. Execute movements
      const movements = [];
      for (const item of transaction.items) {
        const movement = await this.executeMovement(item, trx);
        movements.push(movement);
        
        // 4. Update inventory quantities
        await this.updateInventoryQuantity(item, trx);
      }

      // 5. Log transaction
      await this.logTransaction(transaction, movements, trx);

      // 6. Trigger webhooks/notifications
      await this.notifyInventoryChange(movements, trx);

      return {
        success: true,
        transactionId: transaction.id,
        movements
      };
    });
  }

  private async validateTransaction(
    transaction: InventoryTransaction, 
    trx: Transaction
  ): Promise<ValidationResult> {
    const errors = [];

    for (const item of transaction.items) {
      // Check available quantity
      const available = await this.getAvailableQuantity(item.id, trx);
      if (item.quantityChange < 0 && Math.abs(item.quantityChange) > available) {
        errors.push(`Insufficient quantity for item ${item.id}`);
      }

      // Validate location exists
      const locationExists = await this.locationExists(item.targetLocation, trx);
      if (!locationExists) {
        errors.push(`Invalid location: ${item.targetLocation}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }
}
```

This pattern ensured data consistency even under high concurrency. During peak receiving periods, QuickLotz processes 50+ concurrent transactions without data corruption.

### 2. Real-Time Location Tracking

Physical inventory needs real-time location awareness:

```typescript
interface LocationSystem {
  // Hierarchical location structure
  warehouse: string;    // "MAIN"
  zone: string;         // "A"
  aisle: string;        // "01"
  rack: string;         // "05"
  shelf: string;        // "B"
  bin: string;          // "003"
}

class LocationManager {
  // Generate next available location
  async getNextAvailableLocation(
    zone: string, 
    itemDimensions: Dimensions
  ): Promise<LocationCode> {
    const availableLocations = await this.db.query(`
      SELECT location_code, capacity_cubic_feet
      FROM locations 
      WHERE zone = $1 
        AND available_capacity >= $2
        AND status = 'active'
      ORDER BY utilization_percent ASC
      LIMIT 1
    `, [zone, itemDimensions.cubicFeet]);

    if (availableLocations.length === 0) {
      throw new Error(`No available locations in zone ${zone}`);
    }

    return availableLocations[0].location_code;
  }

  // Optimize pick paths
  async generatePickPath(pickList: PickItem[]): Promise<OptimizedPath> {
    // Sort locations by zone -> aisle -> rack -> shelf
    const sortedPicks = pickList.sort((a, b) => {
      const locA = this.parseLocation(a.location);
      const locB = this.parseLocation(b.location);
      
      // Zone first
      if (locA.zone !== locB.zone) {
        return locA.zone.localeCompare(locB.zone);
      }
      
      // Then aisle number
      const aisleA = parseInt(locA.aisle);
      const aisleB = parseInt(locB.aisle);
      if (aisleA !== aisleB) {
        return aisleA - aisleB;
      }
      
      // Then rack number
      const rackA = parseInt(locA.rack);
      const rackB = parseInt(locB.rack);
      return rackA - rackB;
    });

    return {
      picks: sortedPicks,
      estimatedWalkTime: this.calculateWalkTime(sortedPicks),
      totalDistance: this.calculateDistance(sortedPicks)
    };
  }
}
```

This location system reduced average pick time by 40% compared to their previous manual system.

## Integration Challenges and Solutions

### ERP Integration

QuickLotz needed real-time sync with their existing ERP system without disrupting daily operations:

```typescript
class ERPIntegrationService {
  private syncQueue = new Queue('erp-sync');

  async syncInventoryChange(change: InventoryChange): Promise<void> {
    // Queue for async processing
    await this.syncQueue.add('inventory-sync', {
      changeId: change.id,
      type: change.type,
      items: change.items,
      timestamp: change.timestamp
    }, {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000
      }
    });
  }

  // Process sync jobs
  private setupSyncProcessor(): void {
    this.syncQueue.process('inventory-sync', async (job) => {
      const { changeId, items } = job.data;
      
      try {
        // Transform to ERP format
        const erpItems = items.map(item => ({
          itemCode: item.sku,
          warehouse: item.location.warehouse,
          quantity: item.quantity,
          unitCost: item.averageCost,
          lastUpdated: item.updatedAt
        }));

        // Send to ERP API
        const response = await this.erpClient.updateInventory({
          items: erpItems,
          transactionId: changeId
        });

        if (!response.success) {
          throw new Error(`ERP sync failed: ${response.error}`);
        }

        // Mark as synced
        await this.markSyncComplete(changeId);
        
      } catch (error) {
        console.error(`ERP sync failed for change ${changeId}:`, error);
        throw error; // Will trigger retry
      }
    });
  }
}
```

### Barcode and RFID Integration

Physical inventory tracking required seamless barcode scanning integration:

```typescript
interface ScanEvent {
  scanId: string;
  barcode: string;
  scanType: 'receive' | 'pick' | 'count' | 'move';
  userId: string;
  location: string;
  timestamp: Date;
}

class ScanProcessor {
  async processScan(scanEvent: ScanEvent): Promise<ScanResult> {
    // Decode barcode to extract item info
    const itemInfo = this.decodeBarcodeFormat(scanEvent.barcode);
    
    switch (scanEvent.scanType) {
      case 'receive':
        return await this.processReceiveScan(itemInfo, scanEvent);
        
      case 'pick':
        return await this.processPickScan(itemInfo, scanEvent);
        
      case 'count':
        return await this.processCountScan(itemInfo, scanEvent);
        
      case 'move':
        return await this.processMoveScan(itemInfo, scanEvent);
        
      default:
        throw new Error(`Unknown scan type: ${scanEvent.scanType}`);
    }
  }

  private async processPickScan(
    itemInfo: ItemInfo, 
    scanEvent: ScanEvent
  ): Promise<ScanResult> {
    // Verify item is at expected location
    const inventoryItem = await this.findInventoryItem(
      itemInfo.sku, 
      scanEvent.location
    );
    
    if (!inventoryItem) {
      return {
        success: false,
        error: 'Item not found at this location',
        suggestedActions: ['Check location', 'Search other locations']
      };
    }

    // Execute pick transaction
    await this.inventoryEngine.executeTransaction({
      type: 'pick',
      items: [{
        id: inventoryItem.id,
        quantityChange: -itemInfo.quantity,
        reason: 'picked_for_order',
        userId: scanEvent.userId
      }]
    });

    return {
      success: true,
      itemPicked: inventoryItem,
      remainingQuantity: inventoryItem.quantity - itemInfo.quantity
    };
  }
}
```

This scanning system achieved 99.8% accuracy and reduced pick errors by 85%.

## Performance Optimization

Building inventory management software from scratch means optimizing for real-world usage patterns. QuickLotz needed sub-second response times even with millions of inventory movements.

### Database Optimization

```sql
-- Partial indexes for active inventory
CREATE INDEX CONCURRENTLY idx_active_inventory 
ON inventory_items (sku, location_code) 
WHERE quantity > 0;

-- Composite index for common queries
CREATE INDEX CONCURRENTLY idx_inventory_lookup 
ON inventory_items (sku, condition, location_code, quantity)
WHERE quantity > 0;

-- Partition large tables by date
CREATE TABLE inventory_movements (
  id UUID DEFAULT gen_random_uuid(),
  item_id UUID NOT NULL,
  movement_type VARCHAR(20) NOT NULL,
  quantity_change INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  -- Partition by month
  CONSTRAINT movements_date_check CHECK (created_at >= DATE '2024-01-01')
) PARTITION BY RANGE (created_at);
```

### Caching Strategy

```typescript
class InventoryCache {
  private redis = new Redis(process.env.REDIS_URL);
  
  // Cache frequently accessed inventory counts
  async getCachedInventory(sku: string): Promise<InventoryItem | null> {
    const cached = await this.redis.get(`inventory:${sku}`);
    if (cached) {
      return JSON.parse(cached);
    }
    return null;
  }

  // Invalidate cache on inventory changes
  async invalidateInventoryCache(sku: string): Promise<void> {
    await Promise.all([
      this.redis.del(`inventory:${sku}`),
      this.redis.del(`inventory:summary:${sku}`),
      // Clear related location caches
      this.redis.del(`location:items:*:${sku}`)
    ]);
  }

  // Preload frequently accessed data
  async preloadInventoryCache(): Promise<void> {
    const topSkus = await this.getTopAccessedSkus(100);
    
    for (const sku of topSkus) {
      const inventory = await this.inventoryService.getInventoryBySku(sku);
      await this.redis.setex(
        `inventory:${sku}`, 
        300, // 5 minute TTL
        JSON.stringify(inventory)
      );
    }
  }
}
```

These optimizations kept 95th percentile response times under 200ms even during peak usage.

## Key Technical Challenges

### 1. Concurrent Inventory Updates

Multiple users updating the same inventory items simultaneously:

**Solution:** Row-level locking with timeout

```typescript
async updateInventoryWithLock(itemId: string, update: InventoryUpdate): Promise<void> {
  const lockKey = `inventory:lock:${itemId}`;
  
  // Acquire distributed lock
  const lock = await this.redis.set(
    lockKey, 
    'locked', 
    'PX', 5000, // 5 second timeout
    'NX'
  );
  
  if (!lock) {
    throw new Error('Inventory item is locked by another operation');
  }
  
  try {
    await this.executeInventoryUpdate(itemId, update);
  } finally {
    await this.redis.del(lockKey);
  }
}
```

### 2. Data Consistency Across Services

Inventory changes needed to
