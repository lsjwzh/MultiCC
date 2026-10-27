// Cocoa adapter invoked by Rust through osascript; no profile or launch logic.
ObjC.import('AppKit');
function run(argv) {
    const source = $(argv[0]), destination = $(argv[1]);
    const size = 512;
    const icon = $.NSImage.alloc.initWithSize($.NSMakeSize(size, size));
    icon.lockFocus;
    $.NSWorkspace.sharedWorkspace.iconForFile(source).drawInRectFromRectOperationFraction(
        $.NSMakeRect(0, 0, size, size), $.NSZeroRect, $.NSCompositingOperationSourceOver, 1);
    const rect = $.NSMakeRect(302, 12, 198, 198);
    const circle = $.NSBezierPath.bezierPathWithOvalInRect(rect);
    const hex = argv[3].slice(1);
    $.NSColor.colorWithSRGBRedGreenBlueAlpha(
        parseInt(hex.slice(0, 2), 16) / 255,
        parseInt(hex.slice(2, 4), 16) / 255,
        parseInt(hex.slice(4, 6), 16) / 255, 1).setFill;
    circle.fill;
    $.NSColor.whiteColor.setStroke;
    circle.lineWidth = 12;
    circle.stroke;
    const text = $(argv[2]);
    let fontSize = 82, attributes, textSize;
    do {
        attributes = $.NSMutableDictionary.alloc.init;
        attributes.setObjectForKey($.NSFont.boldSystemFontOfSize(fontSize), $.NSFontAttributeName);
        attributes.setObjectForKey($.NSColor.whiteColor, $.NSForegroundColorAttributeName);
        textSize = text.sizeWithAttributes(attributes);
        fontSize -= 2;
    } while (textSize.width > 166 && fontSize > 20);
    text.drawAtPointWithAttributes($.NSMakePoint(
        rect.origin.x + (rect.size.width - textSize.width) / 2,
        rect.origin.y + (rect.size.height - textSize.height) / 2), attributes);
    icon.unlockFocus;
    if (!$.NSWorkspace.sharedWorkspace.setIconForFileOptions(icon, destination, 0)) {
        throw new Error('Cannot set identity icon');
    }
}
