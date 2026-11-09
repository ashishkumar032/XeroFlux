import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import App from '../App';
import { ThemeProvider } from '../theme';
vi.mock('../components/IndiaMap',()=>({default:()=> <div aria-label="Unit-test WebGL substitute"/>}));
function renderWorkspace(){const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});return render(<ThemeProvider><QueryClientProvider client={client}><App/></QueryClientProvider></ThemeProvider>);}
beforeEach(()=>{window.localStorage.clear();window.location.hash='#/overview';vi.stubGlobal('fetch',vi.fn().mockImplementation(()=>Promise.resolve(Response.json({error:{code:'NOT_FOUND',message:'Synthetic backend offline test',details:{}}},{status:404}))));});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
describe('Connected workspace navigation',()=>{
 it('keeps filter state when falling back from an unknown route',async()=>{
  window.location.hash='#/unknown?hazard=floods&state_id=SYNTHETIC';renderWorkspace();
  expect(screen.getByText(/Page not found/)).toHaveAttribute('role','status');
  expect(screen.getByRole('link',{name:'Disaster Explorer'})).toHaveAttribute('href','#/explorer?hazard=floods&state_id=SYNTHETIC');
  await screen.findByRole('heading',{level:1},{timeout:5000});
 });
 it('returns focus after Escape closes the mobile navigation drawer',()=>{
  renderWorkspace();fireEvent.click(screen.getByRole('button',{name:'Open navigation'}));
  expect(screen.getByRole('dialog')).toBeInTheDocument();fireEvent.keyDown(document,{key:'Escape'});
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();expect(screen.getByRole('button',{name:'Open navigation'})).toHaveFocus();
 });
 it('offers an actual health retry when the backend fails',async()=>{
  renderWorkspace();const button=await screen.findByRole('button',{name:'Backend offline · Retry'});
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({status:'ok',service:'Synthetic health only',data_ready:true,analytics_configured:false,limitations:[]}));
  fireEvent.click(button);await waitFor(()=>expect(screen.getByText('Historical API connected')).toBeInTheDocument());
 });
 it('resets route filters without clearing the saved theme',async()=>{
  window.location.hash='#/overview?state_id=SYNTHETIC&observation_date=2020-01-01';
  window.localStorage.setItem('climatelens-theme','dark');
  renderWorkspace();
  await screen.findByRole('heading',{level:1},{timeout:5000});
  fireEvent.click(screen.getByText('Active filters'));
  expect(screen.getByText('SYNTHETIC')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Reset filters'}));
  await waitFor(()=>expect(window.location.hash).toBe('#/overview'));
  expect(window.localStorage.getItem('climatelens-theme')).toBe('dark');
  expect(screen.getByRole('switch',{name:'Dark mode'})).toBeChecked();
 });
});
