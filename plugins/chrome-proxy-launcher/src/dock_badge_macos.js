// Cocoa adapter invoked by Rust through osascript; no profile or launch logic.
ObjC.import('AppKit');
function run(argv) {
    const source = $(argv[0]), destination = $(argv[1]);
    const size = 512;
    const icon = $.NSImage.alloc.initWithSize($.NSMakeSize(size, size));
    icon.lockFocus;
    $.NSWorkspace.sharedWorkspace.iconForFile(source).drawInRectFromRectOperationFraction(
        $.NSMakeRect(0, 0, size, size), $.NSZeroRect, $.NSCompositingOperationSourceOver, 1);
    // A full-width nameplate stays legible when the Dock shrinks the icon.
    const rect = $.NSMakeRect(28, 28, 456, 174);
    const plate = $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius(rect, 52, 52);
    const hex = argv[3].slice(1);
    $.NSColor.colorWithSRGBRedGreenBlueAlpha(
        parseInt(hex.slice(0, 2), 16) / 255,
        parseInt(hex.slice(2, 4), 16) / 255,
        parseInt(hex.slice(4, 6), 16) / 255, 1).setFill;
    plate.fill;
    // Square upper corners and rounded lower corners match a bottom label strip.
    $.NSBezierPath.bezierPathWithRect($.NSMakeRect(rect.origin.x,
        rect.origin.y + rect.size.height / 2, rect.size.width, rect.size.height / 2)).fill;
    const text = $(argv[2]);
    let fontSize = 136, attributes, textSize;
    do {
        attributes = $.NSMutableDictionary.alloc.init;
        attributes.setObjectForKey($.NSFont.boldSystemFontOfSize(fontSize), $.NSFontAttributeName);
        attributes.setObjectForKey($.NSColor.colorWithSRGBRedGreenBlueAlpha(
            16 / 255, 21 / 255, 16 / 255, 1), $.NSForegroundColorAttributeName);
        textSize = text.sizeWithAttributes(attributes);
        fontSize -= 2;
    } while ((textSize.width > rect.size.width - 30 || textSize.height > rect.size.height - 6) && fontSize > 24);
    text.drawAtPointWithAttributes($.NSMakePoint(
        rect.origin.x + (rect.size.width - textSize.width) / 2,
        rect.origin.y + (rect.size.height - textSize.height) / 2), attributes);
    icon.unlockFocus;
    if (!$.NSWorkspace.sharedWorkspace.setIconForFileOptions(icon, destination, 0)) {
        throw new Error('无法设置身份名牌图标');
    }
}
