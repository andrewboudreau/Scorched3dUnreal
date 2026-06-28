"""
Generates /Game/Sandbox/M_Terrain_Auto — a procedural slope/height auto-material for the
sandbox terrain (no textures/UVs required). Run ONCE inside the Unreal editor:
  Window > Python (or the Output Log cmd line set to Python), then:
      exec(open(r"C:/Users/andre/source/repos/Scorched3dUnreal/tools/make_terrain_material.py").read())
Requires the "Python Editor Script Plugin" enabled.

Blend logic (BaseColor):
  slope  = saturate(VertexNormalWS.Z)                  # 1 on flats, ->0 on cliffs
  height = saturate((WorldPos.Z - LowZ) / (HighZ-LowZ))# 0 low, 1 high
  ground = lerp(Rock, Grass, slope)                    # cliffs rock, flats grass
  color  = lerp(ground, Snow, height * slope)          # high flat areas go snowy
"""
import unreal

PKG_PATH = "/Game/Sandbox"
ASSET_NAME = "M_Terrain_Auto"
LOW_Z = 0.0
HIGH_Z = 5000.0  # matches GameMode HillAmplitude; peaks above this read as snow

mel = unreal.MaterialEditingLibrary
tools = unreal.AssetToolsHelpers.get_asset_tools()

# Create (or replace) the material asset.
if unreal.EditorAssetLibrary.does_asset_exist(f"{PKG_PATH}/{ASSET_NAME}"):
    unreal.EditorAssetLibrary.delete_asset(f"{PKG_PATH}/{ASSET_NAME}")
mat = tools.create_asset(ASSET_NAME, PKG_PATH, unreal.Material, unreal.MaterialFactoryNew())

def expr(cls, x, y):
    return mel.create_material_expression(mat, cls, x, y)

# --- slope = saturate(VertexNormalWS.Z) ---
normal = expr(unreal.MaterialExpressionVertexNormalWS, -1300, -200)
slope_mask = expr(unreal.MaterialExpressionComponentMask, -1050, -200)
slope_mask.set_editor_property("r", False)
slope_mask.set_editor_property("g", False)
slope_mask.set_editor_property("b", True)   # Z component
slope_mask.set_editor_property("a", False)
mel.connect_material_expressions(normal, "", slope_mask, "")
slope = expr(unreal.MaterialExpressionSaturate, -850, -200)
mel.connect_material_expressions(slope_mask, "", slope, "")

# --- height = saturate((WorldPos.Z - LOW_Z) / (HIGH_Z - LOW_Z)) ---
wpos = expr(unreal.MaterialExpressionWorldPosition, -1300, 200)
wz = expr(unreal.MaterialExpressionComponentMask, -1050, 200)
wz.set_editor_property("r", False); wz.set_editor_property("g", False)
wz.set_editor_property("b", True);  wz.set_editor_property("a", False)
mel.connect_material_expressions(wpos, "", wz, "")
sub = expr(unreal.MaterialExpressionSubtract, -850, 200)
sub.set_editor_property("const_b", LOW_Z)
mel.connect_material_expressions(wz, "", sub, "A")
div = expr(unreal.MaterialExpressionDivide, -650, 200)
div.set_editor_property("const_b", max(1.0, HIGH_Z - LOW_Z))
mel.connect_material_expressions(sub, "", div, "A")
height = expr(unreal.MaterialExpressionSaturate, -450, 200)
mel.connect_material_expressions(div, "", height, "")

# --- colors ---
def color(r, g, b, x, y):
    c = expr(unreal.MaterialExpressionConstant3Vector, x, y)
    c.set_editor_property("constant", unreal.LinearColor(r, g, b, 1.0))
    return c

grass = color(0.08, 0.30, 0.06, -650, -500)
rock  = color(0.25, 0.22, 0.18, -650, -350)
snow  = color(0.90, 0.92, 0.95, -650, -150)

# ground = lerp(Rock, Grass, slope)
ground = expr(unreal.MaterialExpressionLinearInterpolate, -300, -350)
mel.connect_material_expressions(rock,  "", ground, "A")
mel.connect_material_expressions(grass, "", ground, "B")
mel.connect_material_expressions(slope, "", ground, "Alpha")

# snowAmt = height * slope (only high AND flat areas go snowy)
snow_amt = expr(unreal.MaterialExpressionMultiply, -300, 100)
mel.connect_material_expressions(height, "", snow_amt, "A")
mel.connect_material_expressions(slope,  "", snow_amt, "B")

# color = lerp(ground, Snow, snowAmt)
final = expr(unreal.MaterialExpressionLinearInterpolate, -50, -200)
mel.connect_material_expressions(ground,   "", final, "A")
mel.connect_material_expressions(snow,     "", final, "B")
mel.connect_material_expressions(snow_amt, "", final, "Alpha")

# Hook BaseColor; a little roughness.
mel.connect_material_property(final, "", unreal.MaterialProperty.MP_BASE_COLOR)
rough = expr(unreal.MaterialExpressionConstant, -50, 100)
rough.set_editor_property("r", 0.9)
mel.connect_material_property(rough, "", unreal.MaterialProperty.MP_ROUGHNESS)

mel.recompile_material(mat)
unreal.EditorAssetLibrary.save_asset(f"{PKG_PATH}/{ASSET_NAME}")
unreal.log(f"Created {PKG_PATH}/{ASSET_NAME}")
