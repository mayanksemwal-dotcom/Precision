import { readFileSync, writeFileSync } from 'fs';

const file = 'firestore.rules';
let content = readFileSync(file, 'utf-8');

const regex = /match \/tmsShifts\/\{shiftId\} \{[\s\S]*?allow delete: if isAdmin\(\);\n    \}/;

const replacement = `match /tmsShifts/{shiftId} {
      allow read: if isVerified();
      allow create: if isVerified() && (isTL() || isAdmin() || isOwner(incoming().userId));
      
      // Strict state machine enforcement
      allow update: if isVerified() && (isOwner(existing().userId) || isTL() || isAdmin()) && (
        
        // If current state is ACTIVE/BREAK
        (existing().status == 'ACTIVE' || existing().status == 'BREAK') ? (
          
          // Terminal transition attempt
          (incoming().status in ['COMPLETED', 'COMPLETED_FORCED', 'AUTO_CLOSED', 'CLOCKED_OUT', 'CLOSED', 'ENDED']) ? (
            
            // Only explicit allowed transitions
            (incoming().status == 'COMPLETED' && isOwner(existing().userId) && incoming().clockOutTime != null) ||
            (incoming().status == 'COMPLETED_FORCED' && (isTL() || isAdmin()))
            
            // Note: AUTO_CLOSED is strictly forbidden from client side
          ) : (
            // Non-terminal updates (heartbeats, activities, break toggle)
            // MUST NOT add a clockOutTime!
            (!incoming().keys().hasAny(['clockOutTime']) || incoming().clockOutTime == existing().clockOutTime || incoming().clockOutTime == null || incoming().clockOutTime == "")
          )
        ) : (
          // If current state is already terminal, only TLs and Admins can update (Historical Correction)
          (isTL() || isAdmin())
        )
      );
      allow delete: if isAdmin();
    }`;

content = content.replace(regex, replacement);
writeFileSync(file, content, 'utf-8');
console.log("Replaced rules");
