# png2svg

PNG-to-SVG tracer Figma plugin. It traces the edges of non-transparent parts of PNG images and converts them into stroked vector paths.

## How It Works

1. Image selection and validation
2. PNG decoding (extract pixel data)
3. Edge detection (Moore neighborhood contour tracing)
4. Path creation (convert edges into vector paths with strokes)

## Current Implementation Status

This plugin demonstrates the complete structure for PNG edge tracing:
- Image selection and validation
- PNG chunk parsing (IHDR, IDAT chunks)
- Edge detection algorithm (Moore neighborhood contour tracing)
- Vector path creation in Figma

Note: The PNG decoding currently uses a demonstration pattern instead of actual pixel data. To make it work with real PNG images, you'll need to add proper PNG decoding using a zlib decompression library.

## Adding Proper PNG Decoding

To make this plugin work with real PNG images, you need to:

1. Add a zlib decompression library (like `pako` or `png-js`)
2. Decompress the IDAT chunks using inflate
3. Process the decompressed data to handle PNG filters
4. Convert to RGBA format based on the PNG's colorType and bitDepth

### Example using pako library

```javascript
// Install pako: npm install pako
import pako from 'pako';

function inflate(compressed) {
  return pako.inflate(compressed);
}

function processPNGData(decompressed, width, height, bitDepth, colorType) {
  // Process the decompressed data to extract pixel values
  // Handle PNG filters, color types, and bit depths
  // Return RGBA pixel data array
}
```

## Usage

1. Select a PNG image node in Figma
2. Run the plugin from the plugins menu
3. The plugin will trace the edges and create stroked paths

## Project Structure

- `code.js` - Main plugin code
- `manifest.json` - Plugin configuration
- `package.json` - Dependencies (if using npm packages)

## For Educational Purposes

This plugin is designed for an Intro to React course, demonstrating:
- Figma plugin API usage
- Image processing concepts
- Edge detection algorithms
- Vector path creation

The code structure is complete and will work once proper PNG decoding is added.
