---
title: "Building QuickLotz WMS: A Custom Warehouse Management System Case Study"
description: "How we built a full-stack custom warehouse management system for a liquidation business, handling 10K+ SKUs with real-time tracking and automated workflows."
pubDate: 2026-04-16
category: software-engineering
tags: [Warehouse Management, TypeScript, React, PostgreSQL, Case Study]
targetKeyword: "warehouse management system custom development"
---

When a rapidly growing liquidation business approached us with their warehouse management challenges, they had already tried three different off-the-shelf WMS solutions. None could handle their unique workflow: processing mystery pallets, bulk lots with variable SKU counts, and dynamic pricing based on item conditions discovered during receiving.

This is the story of QuickLotz WMS — a warehouse management system custom development project that transformed their operations from manual spreadsheets and sticky notes to a fully automated, real-time system managing 10,000+ SKUs across multiple warehouse locations.

## The Problem: Why Off-the-Shelf Failed

### Unique Business Model Requirements

QuickLotz operates differently from traditional warehouses. They purchase liquidation pallets sight-unseen, then must:

- Receive pallets with unknown contents
- Inspect and categorize items by condition (new, open box, damaged)
- Create SKUs on-the-fly for previously unknown products
- Price items dynamically based on condition and market research
- Track partial quantities when breaking down bulk lots

Standard WMS platforms like NetSuite, Fishbowl, and even industry-specific solutions couldn't adapt to this workflow. They required pre-defined SKUs, fixed pricing structures, and predictable receiving processes.

### Integration Challenges

The business also needed tight integration with:
- eBay and Amazon seller accounts for multi-channel listing
- Shipping carriers (UPS, FedEx, USPS) for rate shopping
- Accounting systems for real-time financial reporting
- Barcode printing systems for custom label formats

Previous attempts at integration required expensive middleware or manual data entry between systems.

## Solution Architecture: Building for Flexibility

### Tech Stack Selection

We chose a full-stack TypeScript approach for QuickLotz WMS:

```typescript
// Core stack
Frontend: React + TypeScript + Vite
Backend: Node.js + Express + TypeScript
Database: PostgreSQL with Prisma ORM
Infrastructure: Docker containers on dedicated servers
Real-time: WebSocket connections for live updates
```

TypeScript across the entire stack eliminated the interface mismatches that plague warehouse systems — critical when handling complex inventory state changes in real-time.

### Database Design for Dynamic Inventory

The core challenge was designing a schema that could handle unknown products appearing during receiving:

```sql
-- Flexible product schema
CREATE TABLE products (
  id UUID PRIMARY KEY,
  upc VARCHAR(20),
  title TEXT NOT NULL,
  brand VARCHAR(100),
  category_id UUID,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Condition-based inventory tracking
CREATE TABLE inventory_items (
  id UUID PRIMARY KEY,
  product_id UUID REFERENCES products(id),
  location_id UUID REFERENCES locations(id),
  condition ENUM('new', 'open_box', 'damaged', 'for_parts'),
  quantity INTEGER NOT NULL,
  cost_basis DECIMAL(10,2),
  received_date TIMESTAMP,
  lot_number VARCHAR(50)
);

-- Dynamic pricing by condition
CREATE TABLE pricing_rules (
  id UUID PRIMARY KEY,
  product_id UUID REFERENCES products(id),
  condition ENUM('new', 'open_box', 'damaged', 'for_parts'),
  base_price DECIMAL(10,2),
  margin_percentage DECIMAL(5,2),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

This schema allows creating products during receiving while maintaining full traceability and condition-specific pricing.

## Core Features: Beyond Standard WMS

### Smart Receiving Workflow

The receiving process needed to handle complete unknowns. We built a progressive workflow:

```typescript
// Receiving workflow state machine
interface ReceivingState {
  pallet_id: string;
  current_item?: {
    barcode?: string;
    photos: string[];
    estimated_quantity: number;
    condition: InventoryCondition;
  };
  created_products: string[];
  processing_status: 'scanning' | 'categorizing' | 'pricing' | 'complete';
}

// Real-time product creation during receiving
async function processUnknownItem(barcode: string, photos: string[]) {
  // Attempt UPC lookup via external APIs
  const productInfo = await lookupUPC(barcode);
  
  if (!productInfo) {
    // AI-powered product identification from photos
    const aiAnalysis = await analyzeProductPhotos(photos);
    return createProductFromAI(aiAnalysis, barcode);
  }
  
  return createProductFromUPC(productInfo, barcode);
}
```

This workflow reduced receiving time by 60% while maintaining data accuracy.

### Real-Time Inventory Tracking

Warehouse staff needed instant visibility into inventory changes. We implemented WebSocket-based real-time updates:

```typescript
// WebSocket event system for inventory changes
class InventoryEventEmitter {
  private clients: Map<string, WebSocket> = new Map();
  
  async updateInventory(locationId: string, changes: InventoryChange[]) {
    // Update database
    await this.db.inventory.updateMany(changes);
    
    // Broadcast to all connected clients
    const update = {
      type: 'INVENTORY_UPDATE',
      locationId,
      changes,
      timestamp: new Date().toISOString()
    };
    
    this.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(update));
      }
    });
  }
}
```

Staff could see inventory changes instantly across all devices, eliminating the "ghost inventory" problem common in busy warehouses.

### Intelligent Pick Path Optimization

For order fulfillment, we implemented dynamic pick path optimization:

```typescript
// Pick path optimization algorithm
interface PickTask {
  orderId: string;
  productId: string;
  locationId: string;
  quantity: number;
  priority: number;
}

function optimizePickPath(tasks: PickTask[], warehouseLayout: Location[]): PickTask[] {
  // Group by picker capacity and priority
  const batches = batchTasks(tasks, PICKER_CAPACITY);
  
  return batches.map(batch => {
    // Nearest neighbor algorithm with warehouse zone optimization
    return optimizeRouteWithinBatch(batch, warehouseLayout);
  }).flat();
}
```

This reduced average pick time from 12 minutes per order to 7 minutes, while reducing picker walking distance by 40%.

## Integration Challenges and Solutions

### Multi-Channel Listing Automation

One major requirement was automatically listing items across eBay, Amazon, and their own e-commerce site. We built a unified listing engine:

```typescript
// Multi-channel listing orchestrator
class ListingOrchestrator {
  private channels: Map<string, ListingChannel> = new Map();
  
  async createListings(product: Product, inventory: InventoryItem[]) {
    const listingData = await this.generateListingContent(product);
    
    const promises = Array.from(this.channels.entries()).map(
      async ([channelName, channel]) => {
        try {
          const result = await channel.createListing(
            this.adaptForChannel(listingData, channelName)
          );
          
          await this.recordListing(product.id, channelName, result);
          return { channel: channelName, success: true, result };
        } catch (error) {
          return { channel: channelName, success: false, error };
        }
      }
    );
    
    return Promise.all(promises);
  }
}
```

This automated 90% of their listing process, freeing up hours of manual work daily.

### Shipping Integration and Rate Shopping

For shipping, we integrated with multiple carriers and implemented real-time rate shopping:

```typescript
// Multi-carrier rate shopping
async function getShippingRates(shipment: ShipmentRequest): Promise<ShippingRate[]> {
  const carriers = [new UPSApi(), new FedExApi(), new USPSApi()];
  
  const ratePromises = carriers.map(async carrier => {
    try {
      const rates = await carrier.getRates(shipment);
      return rates.map(rate => ({ ...rate, carrier: carrier.name }));
    } catch (error) {
      console.warn(`${carrier.name} rate lookup failed:`, error);
      return [];
    }
  });
  
  const allRates = (await Promise.all(ratePromises)).flat();
  
  // Sort by cost, but factor in delivery time for priority orders
  return allRates.sort((a, b) => {
    if (shipment.priority === 'rush') {
      return a.deliveryTime - b.deliveryTime;
    }
    return a.cost - b.cost;
  });
}
```

This reduced shipping costs by an average of 15% through optimal carrier selection.

## Performance Optimization

### Database Performance at Scale

With 10,000+ SKUs and hundreds of daily transactions, database performance was critical:

```typescript
// Optimized inventory queries with proper indexing
CREATE INDEX idx_inventory_location_product ON inventory_items(location_id, product_id);
CREATE INDEX idx_inventory_condition_quantity ON inventory_items(condition, quantity) WHERE quantity > 0;
CREATE INDEX idx_products_search ON products USING gin(to_tsvector('english', title || ' ' || brand));

// Cached frequent queries
class InventoryService {
  private cache = new NodeCache({ stdTTL: 300 }); // 5-minute cache
  
  async getAvailableInventory(locationId: string): Promise<InventoryItem[]> {
    const cacheKey = `inventory:${locationId}`;
    let inventory = this.cache.get<InventoryItem[]>(cacheKey);
    
    if (!inventory) {
      inventory = await this.db.inventoryItem.findMany({
        where: { 
          locationId, 
          quantity: { gt: 0 } 
        },
        include: { product: true, location: true }
      });
      this.cache.set(cacheKey, inventory);
    }
    
    return inventory;
  }
}
```

These optimizations kept query response times under 100ms even with complex inventory searches.

### Frontend Performance

For the React frontend, we implemented strategic code splitting and data fetching:

```typescript
// Lazy loading for warehouse modules
const ReceivingModule = lazy(() => import('./modules/Receiving'));
const PickingModule = lazy(() => import('./modules/Picking'));
const InventoryModule = lazy(() => import('./modules/Inventory'));

// React Query for optimistic updates
const useInventoryMutation = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: updateInventory,
    onMutate: async (updates) => {
      // Optimistically update the UI
      await queryClient.cancelQueries(['inventory']);
      const previousInventory = queryClient.getQueryData(['inventory']);
      
      queryClient.setQueryData(['inventory'], (old: InventoryItem[]) =>
        applyOptimisticUpdates(old, updates)
      );
      
      return { previousInventory };
    },
    onError: (error, updates, context) => {
      // Revert on error
      queryClient.setQueryData(['inventory'], context?.previousInventory);
    }
  });
};
```

This kept the UI responsive during high-traffic periods while maintaining data consistency.

## Results and Impact

### Operational Improvements

After six months of operation, QuickLotz WMS delivered measurable results:

**Receiving Efficiency**
- 60% reduction in receiving time per pallet
- 95% accuracy in auto-generated SKUs
- Eliminated manual data entry for 80% of received items

**Inventory Accuracy**
- 99.2% inventory accuracy (up from 87% with manual tracking)
- Real-time visibility across all locations
- Reduced "phantom inventory" to near zero

**Order Fulfillment**
- 40% reduction in pick path distance
- 7-minute average pick time (down from 12 minutes)
- 99.5% order accuracy rate

**Cost Savings**
- 15% reduction in shipping costs through rate optimization
- 25% reduction in labor costs for warehouse operations
- Eliminated licensing fees for previous WMS attempts ($3,200/month saved)

### Technical Achievements

From a warehouse management system custom development perspective, several technical innovations proved particularly valuable:

**Dynamic Schema Design**
Our flexible product and inventory schema handled 15,000+ unique products created during receiving, with zero database schema changes required.

**Real-Time Architecture**
WebSocket-based real-time updates supported 25+ concurrent users across multiple warehouse locations with sub-second latency.

**Integration Stability**
The unified API layer successfully handled 50,000+ API calls monthly across eBay, Amazon, and shipping carriers with 99.8% uptime.

## Lessons Learned

### Why Custom Development Was the Right Choice

Three key factors made warehouse management system custom development the optimal solution:

1. **Business Model Uniqueness**: The liquidation workflow couldn't be forced into standard WMS patterns without significant operational compromises.

2. **Integration Requirements**: The existing software ecosystem required deep, custom integrations that would have cost more in middleware than building custom.

3. **Growth Trajectory**: The business was scaling rapidly, and custom development allowed the system to evolve with changing requirements.

### Technical Decisions That Paid Off

**TypeScript Everywhere**: Using TypeScript across the full stack eliminated a entire class of integration bugs and made the codebase much more maintainable.

**PostgreSQL Over NoSQL**: Despite the dynamic nature of inventory data, the relational guarantees of PostgreSQL proved crucial for financial accuracy and reporting.

**Real-Time by Design**: Building WebSocket support from day one, rather than adding it later, made the system feel responsive and modern to warehouse staff.

### What We'd Do Differently

**Earlier Performance Testing**: We should have load-tested the system with realistic data volumes sooner. Some database optimizations were needed after deployment.

**More Granular Permissions**: The initial role-based access system worked but required enhancement as the team grew and responsibilities became more specialized.

**Better Mobile Support**: While the responsive design worked on tablets, dedicated mobile screens for common tasks like cycle counting would have improved usability.

## Key Takeaways

- **Custom WMS development pays off when your business model doesn't fit standard patterns** — liquidation, subscription boxes, and other unique workflows often require purpose-built solutions
- **Real-time inventory tracking eliminates most "ghost inventory" issues** — WebSocket updates keep everyone working with current data
- **TypeScript across the full stack reduces integration bugs significantly** — especially important in warehouse systems where data accuracy is critical
- **Database performance matters more than you think** — proper indexing and query optimization becomes crucial as inventory scales
- **Multi-channel integrations require robust error handling** — external APIs will fail, and your system needs to handle it gracefully
- **Staff training is as important as technical implementation** — the best system fails if warehouse staff don't understand how to use it effectively

Building QuickLotz WMS reinforced our belief that warehouse management system custom development often delivers better ROI than forcing unique business models into rigid off-the-shelf solutions. The key is identifying early whether your requirements truly demand custom development or if configuration of existing systems will suffice.

Similar challenges around [AI automation for warehouse operations](/ai-automation/inventory-management) are becoming common as businesses look to optimize their operations further. We've also seen success applying similar custom development approaches to other complex business workflows, as detailed in our post on [automating business workflows with Python](/blog/2026-04-14-automating-business-workflows-with-python).

If you're building a warehouse management system or dealing with complex inventory workflows that don't fit standard WMS patterns, we'd love to help. [Reach out](/contact) to discuss your project.
