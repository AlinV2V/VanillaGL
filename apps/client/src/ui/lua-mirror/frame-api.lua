-- Prototype host API. Original MirrorTimer.lua/XML are separate, unmodified assets.
local frames, order = {}, {}
local methods = {}
function getglobal(name) return _G[name] end
STATICPOPUP_NUMDIALOGS = 4 -- StaticPopup.lua dependency; timer admission is bounded to 3.
function methods:GetName() return self.name end
function methods:IsShown() return not self.hidden end
function methods:IsVisible()
  return not self.hidden and (not self.parent or frames[self.parent]:IsVisible())
end
function methods:Show() self.hidden = false; __ui(self.name, 'hidden', false) end
function methods:Hide() self.hidden = true; __ui(self.name, 'hidden', true) end
function methods:RegisterEvent(name) self.events[name] = true end
function methods:GetFrameLevel() return self.level end
function methods:SetFrameLevel(value) self.level = value; __ui(self.name, 'level', value) end
function methods:SetText(value) __ui(self.name, 'text', value) end
function methods:SetMinMaxValues(low, high)
  self.minimum, self.maximum = low, high
  __ui(self.name, 'range', low, high)
end
function methods:SetValue(value) __ui(self.name, 'value', value) end
function methods:SetStatusBarColor(r, g, b) __ui(self.name, 'color', r, g, b) end
function __create(name, parent, hidden, level)
  local frame = setmetatable({name=name, parent=parent, hidden=hidden, level=level, events={}, scripts={}}, {__index=methods})
  frames[name], _G[name] = frame, frame
  order[#order+1] = frame
end
function __script(name, kind, source)
  frames[name].scripts[kind] = assert(load(source, '@'..name..':'..kind))
end
local function invoke(frame, kind, eventName, ...)
  local fn = frame.scripts[kind]
  if not fn then return end
  local old = {this, event, arg1, arg2, arg3, arg4, arg5, arg6}
  this, event = frame, eventName
  arg1, arg2, arg3, arg4, arg5, arg6 = ...
  local ok, err = pcall(fn)
  this, event, arg1, arg2, arg3, arg4, arg5, arg6 = table.unpack(old, 1, 8)
  if not ok then error(err) end
end
function __initialize()
  -- All names exist before callbacks; child OnLoad runs before its owner's OnLoad.
  for i=#order,1,-1 do invoke(order[i], 'OnLoad', nil) end
end
function __event(name, ...)
  for _,frame in ipairs(order) do
    if frame.events[name] then invoke(frame, 'OnEvent', name, ...) end
  end
end
function __tick(elapsed)
  for _,frame in ipairs(order) do
    if frame:IsVisible() then invoke(frame, 'OnUpdate', nil, elapsed) end
  end
end
function __start(timer, value, maximum, scale, paused, label)
  local available = false
  for i=1,MIRRORTIMER_NUMTIMERS do
    local frame = frames['MirrorTimer'..i]
    if not frame:IsShown() or frame.timer == timer then available = true end
  end
  if not available then return false end
  -- UIParent.lua's MIRROR_TIMER_START event calls this original function.
  return MirrorTimer_Show(timer, value, maximum, scale, paused, label) ~= nil
end
function __pause(timer, paused, label)
  for i=1,MIRRORTIMER_NUMTIMERS do
    local frame = frames['MirrorTimer'..i]
    if frame:IsShown() and frame.timer == timer then
      local bar = frames[frame.name..'StatusBar']
      -- Explicit adapter: original pause handler compares the timer-name arg1
      -- against a number. Keep source intact; reapply state via original Show.
      MirrorTimer_Show(timer, frame.value*1000, bar.maximum*1000, frame.scale, paused, label)
    end
  end
end
function __snapshot()
  local result = {}
  for i=1,MIRRORTIMER_NUMTIMERS do
    local frame = frames['MirrorTimer'..i]
    result[i] = {name=frame.name, shown=frame:IsShown(), timer=frame.timer, value=frame.value, paused=not not frame.paused}
  end
  return result
end
function __active()
  for i=1,MIRRORTIMER_NUMTIMERS do
    local frame = frames['MirrorTimer'..i]
    if frame:IsShown() and not frame.paused then return true end
  end
  return false
end
