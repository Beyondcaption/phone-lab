// Erzeugt das App-Symbol als PNG (1024 px): dunkler Kreis, fünf helle Handys. Aufruf: swift icon.swift out.png
import AppKit
let size = CGFloat(1024), img = NSImage(size: NSSize(width: size, height: size))
img.lockFocus()
let bg = NSBezierPath(roundedRect: NSRect(x: 60, y: 60, width: size - 120, height: size - 120), xRadius: 220, yRadius: 220)
NSGradient(starting: NSColor(red: 0.10, green: 0.35, blue: 0.75, alpha: 1), ending: NSColor(red: 0.05, green: 0.12, blue: 0.30, alpha: 1))!.draw(in: bg, angle: -60)
let w = CGFloat(118), h = CGFloat(230), gap = CGFloat(34), n = 5
let total = CGFloat(n) * w + CGFloat(n - 1) * gap, x0 = (size - total) / 2
for i in 0..<n {
  let x = x0 + CGFloat(i) * (w + gap), y = (size - h) / 2 + (i == 2 ? 40 : (i == 1 || i == 3) ? 20 : 0)
  let phone = NSBezierPath(roundedRect: NSRect(x: x, y: y, width: w, height: h), xRadius: 22, yRadius: 22)
  NSColor(white: 1, alpha: 0.95).setFill(); phone.fill()
  let screen = NSBezierPath(roundedRect: NSRect(x: x + 10, y: y + 26, width: w - 20, height: h - 52), xRadius: 10, yRadius: 10)
  NSColor(red: 0.08, green: 0.16, blue: 0.36, alpha: 1).setFill(); screen.fill()
  let dot = NSBezierPath(ovalIn: NSRect(x: x + w / 2 - 7, y: y + 8, width: 14, height: 14)); NSColor(white: 0.75, alpha: 1).setFill(); dot.fill()
}
img.unlockFocus()
let tiff = img.tiffRepresentation!, png = NSBitmapImageRep(data: tiff)!.representation(using: .png, properties: [:])!
try! png.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
