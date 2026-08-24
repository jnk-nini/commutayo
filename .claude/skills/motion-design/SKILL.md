---
name: motion-design
description: Emil Kowalski motion physics and micro-interaction parameters for commuter steps.
---
- Use Framer Motion spring physics (stiffness: 300, damping: 30) for route cards.
- Micro-interactions max 200ms; entry transitions max 350ms.
- Apply `layout` and `layoutId` props for expanding step-by-step landmark cues.
- Ensure modal dismissals use quick easeOut interpolations (duration <= 150ms).