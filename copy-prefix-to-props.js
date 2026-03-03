import { processEntities } from "./database.js";

await processEntities(
  { list: { $in: ["high-speed"] }, prefix: { $exists: true } },
  
  (entity) => {
    if (!entity.props) {
      entity.props = {};
    }
    
    entity.props.speed = Number(entity.prefix);
  }
);

console.log("✅ Done! All entities updated.");
