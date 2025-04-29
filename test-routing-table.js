import { RoutingTable } from './src/modules/routing-table.js';
import { generateRandomID } from './src/utils.js';

async function testRoutingTable() {
  console.log("Testing RoutingTable implementation...");
  
  // Create a routing table
  const nodeId = await generateRandomID();
  const routingTable = new RoutingTable(nodeId, { debug: true });
  
  console.log(`Created routing table with nodeId: ${nodeId.substring(0, 8)}...`);
  
  // Generate some test nodes
  const testNodes = [];
  for (let i = 0; i < 50; i++) {
    const id = await generateRandomID();
    testNodes.push({ id });
  }
  
  console.log(`Generated ${testNodes.length} test nodes`);
  
  // Add nodes to routing table
  let addedCount = 0;
  for (const node of testNodes) {
    if (routingTable.addNode(node)) {
      addedCount++;
    }
  }
  
  console.log(`Added ${addedCount} nodes to routing table`);
  
  // Get bucket stats
  const bucketStats = routingTable.getBucketStats();
  console.log("Bucket stats:", bucketStats);
  
  // Test closest nodes function
  const targetId = await generateRandomID();
  console.log(`Finding closest nodes to ${targetId.substring(0, 8)}...`);
  
  const closestNodes = routingTable.closest(targetId, 10);
  console.log(`Found ${closestNodes.length} closest nodes`);
  
  // Test getNode and hasNode
  const randomNode = testNodes[Math.floor(Math.random() * testNodes.length)];
  const nodeExists = routingTable.hasNode(randomNode.id);
  console.log(`Random node ${randomNode.id.substring(0, 8)}... exists: ${nodeExists}`);
  
  if (nodeExists) {
    const foundNode = routingTable.getNode(randomNode.id);
    console.log(`Found node: ${foundNode ? 'yes' : 'no'}`);
  }
  
  console.log("Test completed successfully!");
}

testRoutingTable().catch(console.error);