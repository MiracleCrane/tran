import { createRoot } from 'react-dom/client'
import PetApp from './PetApp'

const container = document.getElementById('root')
if (container) {
  createRoot(container).render(<PetApp />)
}
