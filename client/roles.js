// Maps an agent record (agentType + description) to a display role.
export function roleOf(a) {
  const t = `${a.agentType || ''} ${a.description || ''}`.toLowerCase();
  if (a.agent === 'main') return { name: 'Main', icon: 'crown' };
  if (/review|test|qa|audit|verif/.test(t)) return { name: 'Tester', icon: 'flask' };
  if (/explore|investigat|search|research|locat/.test(t)) return { name: 'Explorer', icon: 'search' };
  if (/plan|architect|design/.test(t)) return { name: 'Architect', icon: 'architecture' };
  if (/deploy|devops|infra|release/.test(t)) return { name: 'Deployer', icon: 'rocket' };
  if (/fork/.test(t)) return { name: 'Fork', icon: 'git' };
  return { name: 'Builder', icon: 'code' };
}
