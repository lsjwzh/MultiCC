// CGEvent scroll tool — compiled once by init.sh, used as /tmp/_cu_scroll
// Usage: _cu_scroll <x> <y> <amount>   (amount < 0 = down, > 0 = up)
import Foundation
import CoreGraphics

let a = CommandLine.arguments
let x = Double(a.count > 1 ? a[1] : "760") ?? 760
let y = Double(a.count > 2 ? a[2] : "400") ?? 400
let n = Int32(a.count  > 3 ? a[3] : "-5")  ?? -5

// Move cursor to target position first so the scroll lands in the right window
CGEvent(mouseEventSource: nil, mouseType: .mouseMoved,
        mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left)?
    .post(tap: .cghidEventTap)

for _ in 0..<10 {
    let e = CGEvent(scrollWheelEvent2Source: nil, units: .line,
                    wheelCount: 1, wheel1: n, wheel2: 0, wheel3: 0)
    e?.location = CGPoint(x: x, y: y)
    e?.post(tap: .cghidEventTap)
    usleep(16000) // ~60fps
}
