"""
Generates valid PNG icon files (16x16, 48x48, 128x128) using pure Python standard library.
No PIL/Pillow or third-party dependencies required.
"""
import os
import zlib
import struct
import math

def create_png(width, height, get_pixel_func, output_path):
    raw_bytes = bytearray()
    for y in range(height):
        # Filter type 0 (None)
        raw_bytes.append(0)
        for x in range(width):
            r, g, b, a = get_pixel_func(x, y, width, height)
            raw_bytes.extend([r, g, b, a])
    
    compressed = zlib.compress(bytes(raw_bytes), level=9)
    
    png = bytearray(b'\x89PNG\r\n\x1a\n')
    
    # IHDR chunk
    ihdr_data = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)
    ihdr_crc = zlib.crc32(b'IHDR' + ihdr_data)
    png.extend(struct.pack('>I', len(ihdr_data)))
    png.extend(b'IHDR')
    png.extend(ihdr_data)
    png.extend(struct.pack('>I', ihdr_crc))
    
    # IDAT chunk
    idat_crc = zlib.crc32(b'IDAT' + compressed)
    png.extend(struct.pack('>I', len(compressed)))
    png.extend(b'IDAT')
    png.extend(compressed)
    png.extend(struct.pack('>I', idat_crc))
    
    # IEND chunk
    iend_crc = zlib.crc32(b'IEND')
    png.extend(struct.pack('>I', 0))
    png.extend(b'IEND')
    png.extend(struct.pack('>I', iend_crc))
    
    with open(output_path, 'wb') as f:
        f.write(png)

def icon_pixel(x, y, width, height):
    # Normalized coordinates [-1, 1]
    nx = (x + 0.5) / width * 2 - 1
    ny = (y + 0.5) / height * 2 - 1
    
    # Rounded rectangle background: corner radius = 0.35
    cr = 0.32
    # Distance from inner box
    dx = max(0, abs(nx) - (1 - cr))
    dy = max(0, abs(ny) - (1 - cr))
    corner_dist = math.hypot(dx, dy)
    
    if corner_dist > cr:
        return (0, 0, 0, 0) # Transparent outside
    
    # Smooth edge anti-aliasing
    edge_alpha = 1.0
    if corner_dist > cr - (2.0 / width):
        edge_alpha = max(0.0, min(1.0, (cr - corner_dist) / (2.0 / width)))
    
    # Vibrant Purple to Indigo gradient (PromptOptimizer theme: #6366F1 to #8B5CF6 to #EC4899)
    t = (nx + ny + 2) / 4.0 # 0 to 1
    r_bg = int(99 + (139 - 99) * t + 30 * math.sin(t * math.pi))
    g_bg = int(102 + (92 - 102) * t)
    b_bg = int(241 + (246 - 241) * t)
    
    # Draw central Sparkle / Star shape (4-pointed star)
    # Sparkle centered at (0, -0.05)
    sx = nx
    sy = ny + 0.05
    # 4-point star curve: |sx|^0.5 + |sy|^0.5 <= radius^0.5
    dist_star = math.sqrt(abs(sx)) + math.sqrt(abs(sy))
    star_r = 0.65
    
    # Secondary small sparkle at top-right
    s2x = nx - 0.42
    s2y = ny + 0.42
    dist_s2 = math.sqrt(abs(s2x)) + math.sqrt(abs(s2y))
    star2_r = 0.32
    
    if dist_star < star_r or dist_s2 < star2_r:
        # Star color: crisp bright white with slight golden glow in center
        center_dist = math.hypot(sx, sy)
        if center_dist < 0.15:
            r_star, g_star, b_star = 255, 250, 220
        else:
            r_star, g_star, b_star = 255, 255, 255
        return (r_star, g_star, b_star, int(255 * edge_alpha))
    
    return (r_bg, g_bg, b_bg, int(255 * edge_alpha))

def main():
    icons_dir = os.path.join(os.path.dirname(__file__), 'icons')
    os.makedirs(icons_dir, exist_ok=True)
    
    sizes = [16, 48, 128]
    for s in sizes:
        out_file = os.path.join(icons_dir, f'icon-{s}.png')
        create_png(s, s, icon_pixel, out_file)
        print(f"Generated {out_file} ({s}x{s})")

if __name__ == '__main__':
    main()
